'use strict';

const ConnectWiseRest = require('connectwise-rest');
const opts = require('../config.json').rest;
const cw = new ConnectWiseRest(opts);

const Existing = require('../src/existing');
const dispatch = require('../src/dispatch');

const params = {
    memberIdentifier: 'tchristensen',
    startDate: '2017-07-12',
    endDate: '2017-07-14',
    timezone: 'America/Los_Angeles',

    daily: 9,
    totalCap: 10,
    dry: false,
    tickets: [
        {id: '339429'},
        {id: '340224', hours: 4},
    ],
};

Existing.get(cw, params).then(function (existing) {
    return dispatch(cw, params, existing);
}).then(function (result) {
    console.log(result);
}, function (err) {
    console.error(err);
});
