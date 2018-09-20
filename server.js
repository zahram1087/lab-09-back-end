'use strict';

// need to add .env file in directory with all API_KEYS
// important to put a '.env' in a .gitignore

// Initialising all dependencies we will use
const express = require('express');
const superagent = require('superagent');
const cors = require('cors');
const app = express();
const pg = require('pg');
require('dotenv').config();
// setup database
// will need to add a database to .env
const client = new pg.Client(process.env.DATABASE_URL);
client.connect();
client.on('error', err => console.error(err));

// connecting cors to our app
app.use(cors());

// connecting a .env file in directory


// setting up a port
const PORT = process.env.PORT || 3000;

// getting requests and do function on once recieved
app.get('/location', getLocation); //need to change to getLocation //searchToLatLong
app.get('/weather', getWeather);
app.get('/yelp', getYelp);
app.get('/movies', getMovie);

// running server on a PORT and console.log state
app.listen(PORT, () => console.log(`listening on ${PORT}`));

// Models
// We added a created_at property, in case we want to check how old the cache is at any point
function Location(query, res) {
  // console.log(res.body.results);
  this.search_query = query;
  this.formatted_query = res.body.results[0].formatted_address;
  this.latitude = res.body.results[0].geometry.location.lat;
  this.longitude = res.body.results[0].geometry.location.lng;
  this.created_at = Date.now();
}

// Our SQL query retrieves everything from the database WHERE the search_query property in the row matches the location.query property
// This function is invoked in getLocation, which runs when the /location route is hit
// You may want to design this in a different way, since it is only going to happen for the location and doesn't necessarily need to be dynamic
Location.lookupLocation = (location) => {

  // console.log(location.query);

  const SQL = `SELECT * FROM locations WHERE search_query=$1;`;
  const values = [location.query];

  // console.log('>>>>>>>>>>>>>>>>>>>>>>>' + location.query);

  // Check for this location based on the user's search query
  return client.query(SQL, values)
    .then(result => {
      // Does it exist in the database? Pass the result to the .cacheHit method
      // Remember: the result object contains an array named "rows" which contains objects, one per row from the database. Even when there is only one.
      if (result.rowCount > 0) {
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
  save: function () {
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


//-----------------------------------------------------------
// Functions to run on recieving requests
// ALL API KEYS HAVE TO BE IN .env WITH SAME NAME

//-----------------------------------------
// handle LOCATION request

function searchToLatLong(request, response) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${request.query.data}&key=${process.env.GOOGLE_API_KEY}`;
  return superagent.get(url)
    .then(result => {
      const locationResult =
      {
        search_query: request.query.data,
        formatted_query: result.body.results[0].formatted_address,
        latitude: result.body.results[0].geometry.location.lat,
        longitude: result.body.results[0].geometry.location.lng,
      };
      response.send(locationResult);
    })
    .catch(error => handleError(error));
}

//-----------------------------------------
// handle WEATHER request

//  Clear the results for a location if they are stale
// This is dynamic because it is able to accept a specific table and city as arguments
function deleteByLocationId(table, city) {
  const SQL = `DELETE from ${table} WHERE location_id=${city};`;
  return client.query(SQL);
}

//----------------------------------------------
// GET WEATHER
//----------------------------------------------

function getWeather(request, response) {
  Weather.lookup(
    {
      tableName: Weather.tableName,

      cacheMiss: function () {
        const url = `https://api.darksky.net/forecast/${process.env.WEATHER_API_KEY}/${request.query.data.latitude},${request.query.data.longitude}`;
        return superagent.get(url)
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
      cacheHit: function (resultsArray) {
        let ageOfResultsInMinutes = (Date.now() - resultsArray[0].created_at) / (1000 * 60);
        if (ageOfResultsInMinutes > 30) {
          Weather.deleteByLocationId(Weather.tableName, request.query.data.id);
          this.cacheMiss();
        }
        else {
          response.send(resultsArray);
        }
      }
    })

}

//----------------------------------------------
// GET MOVIE
//----------------------------------------------

function getMovie(request, response) {
  Weather.lookup(
    {
      tableName: Movie.tableName,

      cacheMiss: function () {
        const url = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.THE_MOVIE_DB_API}&query=${request.query.data.search_query}`;
        return superagent.get(url)
          .then(result => {
            const moviesSummaries = result.body.results.map(movie => {
              const summary = new Movie(movie);
              summary.save(request.query.data.id);
              return summary;
            });
            response.send(moviesSummaries);
          })
          .catch(error => handleError(error, response));
      },
      cacheHit: function (resultsArray) {
        let ageOfResultsInDays = (Date.now() - resultsArray[0].created_at) / (1000 * 60 * 1440);
        if (ageOfResultsInDays > 30) {
          Movie.deleteByLocationId(Movie.tableName, request.query.data.id);
          this.cacheMiss();
        }
        else {
          response.send(resultsArray);
        }
      }
    })

}

//-----------------------------------------
// handle YELP request

function getYelp(request, response) {
  const url = `https://api.yelp.com/v3/businesses/search?location=${request.query.data.search_query}`;

  return superagent.get(url)
    .set('Authorization', `Bearer ${process.env.YELP_API_KEY}`)
    .then(result => {
      const yelpSummaries = result.body.businesses.map(business => new Business(business));
      response.send(yelpSummaries);
    })
    .catch(error => handleError(error, response));
}

//-----------------------------------------
// handle MOVIE request

// function getMovie(request, response) {
//   const url = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.THE_MOVIE_DB_API}&query=${request.query.data.search_query}`;

//   return superagent.get(url)
//     .then(result => {
//       const moviesSummaries = result.body.results.map(movie => new Movie(movie));
//       response.send(moviesSummaries);
//     })
//     .catch(error => handleError(error, response));
// }


//-----------------------------------------
// generic error handler function

function handleError(err, res) {
  console.error(err);
  if (res) res.status(500).send('Sorry, something went wrong');
}


//-----------------------------------------
// helping functions for a working with a data
// constructors


function Weather(day) {
  this.tableName = 'weathers'
  this.time = new Date(day.time * 1000).toString().slice(0, 15);
  this.forecast = day.summary;
  this.created_at = Date.now();
}


function Movie(movie) {
  this.tableName = 'movies'
  this.title = movie.title;
  this.overview = movie.overview;
  this.average_votes = movie.vote_average;
  this.image_url = `https://image.tmdb.org/t/p/w500${movie.poster_path}`;
  this.popularity = movie.popularity;
  this.released_on = movie.release_date;
  this.created_at = Date.now();
}

Movie.prototype =
  {
    save: function (location_id) {
      const SQL = `INSERT INTO ${this.tableName} (title, overview, average_votes, image_url, popularity, released_on, location_id) VALUES ($1, $2, $3, $4, $5, $6, $7);`;
      const values = [this.title, this.overview, this.average_votes, this.image_url, this.popularity, this.released_on, location_id];

      client.query(SQL, values);
    }
  };

Weather.prototype =
  {
    // same as Weather.prototype.save()
    save: function (location_id) {
      const SQL = `INSERT INTO ${this.tableName} (forecast, time, created_at, location_id) VALUES ($1, $2, $3,$4);`;
      const values = [this.forecast, this.time, this.created_at, location_id];

      client.query(SQL, values);
    }
  };

// name of table
Weather.tableName = 'weathers';
Movie.tableName = 'movies';

Movie.lookup = (options) => {
  const SQL = `SELECT * FROM ${options.tableName} WHERE location_id=$1`;
  const values = [options.query];

  client.query(SQL, values)
    .then(result => {
      if (result.rowCount > 0) {
        // something to send back to client
        options.cacheHit(result.rows);
      }
      else {
        // requesting data from the API
        options.cacheMiss();
      }
    })
    .catch(error => handleError(error));
};

Weather.lookup = (options) => {
  const SQL = `SELECT * FROM ${options.tableName} WHERE location_id=$1`;
  const values = [options.query];

  client.query(SQL, values)
    .then(result => {
      if (result.rowCount > 0) {
        // something to send back to client
        options.cacheHit(result.rows);
      }
      else {
        // requesting data from the API
        options.cacheMiss();
      }
    })
    .catch(error => handleError(error));
};

function getLocation(request, response) {
  Location.lookupLocation({
    tableName: Location.tableName,

    query: request.query.data,

    // If the location exists, send it
    cacheHit: function (result) {
      response.send(result);
    },

    // If the location doesn't exist, request it from the API, save it in the database, and send it to the client
    cacheMiss: function () {
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





function Business(business) {
  this.name = business.name;
  this.image_url = business.image_url;
  this.price = business.price;
  this.rating = business.rating;
  this.url = business.url;
}

