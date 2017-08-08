'use strict';

const ConnectWiseRest = require('connectwise-rest');
const opts = require('../config.json').rest;
const cw = new ConnectWiseRest(opts);

const Existing = require('../src/existing');
const dispatch = require('../src/dispatch');

const params = {
    // Member to dispatch.
    memberIdentifier: 'tchristensen',
    // Start dispatching on this date (inclusive.)
    startDate: '2017-07-12',
    // Stop dispatching on this date (inclusive.)
    endDate: '2017-07-14',
    // Timezone to dispatch in, beginning at startHour (e.g. 9:00 AM local time.)
    timezone: 'America/Los_Angeles',
    // Hour at which to start dispatching at (per above timezone.)
    startHour: 9,

    // Daily hours to dispatch.
    daily: 9,

    // Sum total of hours to dispatch, at most.
    capTotalHours: 10,

    // Don't assign inactive tickets.
    //   true: Skip canceled, pending qa, pending code review, on-hold, complete, etc.
    //   false: Assign all ticket ids.
    //   string: Skip only this ticket status (use lowercase.)
    //   array: Skip only these ticket statuses (use lowercase.)
    skipByStatus: true,

    // Skip dispatching tickets already dispatched for this member after startDate.
    // Use this to re-run with additional ticket ids or date range.
    //   'subtract': Reduce dispatch hours by already dispatched amount (possibly to zero.)
    //   'skip': Skip, regardless of hours.
    //   'ignore': Redispatch duplicate tickets with currently remaining hours.
    skipDuplicateMode: 'subtract',

    // Move the ticket to Assigned status after dispatching.
    setAssigned: true,

    // Skip actual dispatching, just log (dry-run.)
    dry: true,

    // Tickets to dispatch, array of objects:
    //   id: ticket ID to dispatch
    //   hours: Optional, override hours to dispatch.  NOTE: Will force dispatch of inactive tickets if specified.
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
