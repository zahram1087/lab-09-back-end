'use strict';

// Application Dependencies - Note that we added pg so we can connect to Postgres
const express = require('express');
const superagent = require('superagent');
const cors = require('cors');
const pg = require('pg');

// Setup Database by creating a client instance, pointing it at our database, then connecting it to the database
const client = new pg.Client(process.env.DATABASE_URL);
client.connect();

// Error handling for database
// Write this once so Node knows how to handle errors that arise from the client
client.on('error', err => console.error(err));

// Load environment variables from .env file
require('dotenv').config();

// Application Setup
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// API Routes
// Rather than allow this function to become very long and difficult to read, let's pull the logic out into a helper function and call it when the route is hit
app.get('/location', getLocation)

app.get('/weather', getWeather);

// Make sure the server is listening for requests
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

// Error handler
function handleError(err, res) {
  console.error(err);
  if (res) res.status(500).send('Sorry, something went wrong');
}

// Clear the results for a location if they are stale
// This is dynamic because it is able to accept a specific table and city as arguments
function deleteByLocationId(table, city) {
  const SQL = `DELETE from ${table} WHERE location_id=${city};`;
  return client.query(SQL);
}

// Models
// We added a created_at property, in case we want to check how old the cache is at any point
function Location(query, res) {
  this.search_query = query;
  this.formatted_query = res.body.result[0].formatted_address;
  this.latitude = res.body.results[0].geometry.location.lat;
  this.longitude = res.body.results[0].geometry.location.lng;
  this.created_at = Date.now();
}

// Our SQL query retrieves everything from the database WHERE the search_query property in the row matches the location.query property
// This function is invoked in getLocation, which runs when the /location route is hit
// You may want to design this in a different way, since it is only going to happen for the location and doesn't necessarily need to be dynamic
Location.lookupLocation = (location) => {
  const SQL = `SELECT * FROM locations WHERE search_query=$1;`;
  const values = [location.query];

  // Check for this location based on the user's search query
  return client.query(SQL, values)
    .then(result => {
      // Does it exist in the database? Pass the result to the .cacheHit method
      // Remember: the result object contains an array named "rows" which contains objects, one per row from the database. Even when there is only one.
      if(result.rowCount > 0) {
        location.cacheHit(result.rows[0]);
      // If not in the database, let's request it from the API
      } else {
        location.cacheMiss();
      }
    })
    .catch(console.error);
}

// Add a save method so that we can save each location instance
// Extra verification -- ON CONFLICT DO NOTHING will ensure it's really not there
// RETURNING id -- ensures that the id is returned from the query when we create the instance
// Unless we specifically ask for it, an INSERT statement will not give us the id back
Location.prototype = {
  save: function() {
    // $1 matches this.search_query, $2 matches this.formatted_query, $3 matches latitude, and $4 matches longitude
    const SQL = `INSERT INTO locations (search_query, formatted_query, latitude, longitude) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id;`;
    const values = [this.search_query, this.formatted_query, this.latitude, this.longitude];

    // Now that we have the id, we can add it to the location instance 
    // Why does this matter? We need to include the id when we send the location object to the client so that the other APIs can use it to reference the locations table
    // For example, the weather object need to have a foreign key of location_id, and this id is the source of that value
    return client.query(SQL, values)
      .then(result => {
        this.id = result.rows[0].id;
        return this;
      });
  }
};

// Add the tableName so each instance can be inserted into the correct table
// Add the created_at property to track when the instance was created
function Weather(day) {
  this.tableName = 'weathers';
  this.forecast = day.summary;
  this.time = new Date(day.time * 1000).toString().slice(0, 15);
  this.created_at = Date.now();
}

// Save method on each instance of the Weather constructor
Weather.prototype = {
  // Takes in the location_id that was returned when the location instance was created above
  // This is the reason why we needed to return the id above
  save: function(location_id) {
    const SQL = `INSERT INTO ${this.tableName} (forecast, time, location_id) VALUES ($1, $2, $3, $4);`;
    const values = [this.forecast, this.time, this.created_at, location_id];

    client.query(SQL, values);
  }
}

// Add the table name to the constructor so that we can use it in our lookup function
Weather.tableName = 'weathers';

// When we make a request, use this function to check if the records exist in the database
// You will refactor this into a function named "lookup" and modify as needed to make it DRY and dynamic
Weather.lookup = (options) => {
  const SQL = `SELECT * FROM ${options.tableName} WHERE location_id=$1;`;
  const values = [location];

  client.query(SQL, values)
    .then(result => {
      // if there is more than one record in the database, pass the array of objects as an argument to the cacheHit method
      if(result.rowCount > 0) {
        options.cacheHit(result.rows);
      } else {
        options.cacheMiss();
      }
    })
    .catch(error => handleError(error));
}

function getLocation(request, response) {
  Location.lookupLocation({
    tableName: Location.tableName,

    query: request.query.data,

    // If the location exists, send it
    cacheHit: function(result) {
      response.send(result);
    },

    // If the location doesn't exist, request it from the API, save it in the database, and send it to the client
    cacheMiss: function() {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${this.query}&key=${process.env.GOOGLE_API_KEY}`;

      return superagent.get(url)
        .then(result => {
          const location = new Location(this.query, result);
          // We need a .then() because we want to wait for the id to be returned before sending the location object back to the client
          // If we send the location object back before we receive the id from the database, the other APIs will not know what the request.query.data.id is and it will be undefined
          location.save()
            .then(location => response.send(location));
        })
        .catch(error => handleError(error));
    }
  })
}

// function lookup() {// performs this logic for any table (except locations)}
// Weather.lookup = lookup;

function getWeather(request, response) {
  Weather.lookup({
    tableName: Weather.tableName,

    cacheMiss: function() {
      const url = `https://api.darksky.net/forecast/${process.env.WEATHER_API_KEY}/${request.query.data.latitude},${request.query.data.longitude}`;

      superagent.get(url)
        .then(result => {
          const weatherSummaries = result.body.daily.data.map(day => {
            const summary = new Weather(day);
            summary.save(request.query.data.id);
            return summary;
          });

          response.send(weatherSummaries);
        })
        .catch(error => handleError(error, response));
    },


    cacheHit: function(resultsArray) {
      // Date.now() returns a number in milliseconds since January 1, 1970
      // Subtraction will determine how many milliseconds have elapsed since the instance was created
      // Dividing by 1000 converts the time in milliseconds to a time in seconds
      // Adding 60 to the demonimator (second part of the fraction) will convert seconds to minutes because there are 60 seconds in a minute
      let ageOfResultsInMinutes = ( Date.now() - resultsArray[0].created_at) / (1000 * 60);

      // If the results are older than 30 minutes, nuke them from the database, then request fresh data from the API
      if(ageOfResultsInMinutes > 30) {
        Weather.deleteByLocationId(Weather.tableName, request.query.data.id);
        this.cacheMiss();
      } else {
        // If the results are less than 30 minutes old, send them to the client
        response.send(resultsArray);
      }
    }
  });
}

