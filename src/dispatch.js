'use strict';

const moment = require('moment-timezone');
const Existing = require('./existing');

function round15(hours) {
    // Round to 15 minutes.
    return Math.round(hours * 4) / 4;
}

class Dispatcher {
    constructor(cw, params, existing) {
        this.cw = cw;
        this.params = params;
        this.existing = existing;

        this.date = moment(params.startDate).tz(params.timezone);
        this.nextDate();
    }

    nextDate(force) {
        if (force) {
            // Maybe this day has a little time free, but not enough.  Skip.
            this.date.add(1, 'days');
        }
        this.date = this.beginDay(this.findDay(this.date));
    }

    beginDay(date) {
        return date.hour(9).minute(0).second(0);
    }

    currentHours(date) {
        const current = this.existing[date.format('YYYY-MM-DD')];
        return current ? current.hours : 0;
    }

    findDay(start) {
        let date = moment(start);
        while (this.currentHours(date) >= this.params.daily) {
            date = date.add(1, 'days');
        }
        return date;
    }

    getTicketHours() {
        const ticketIds = this.params.tickets.map(t => t.id);

        return this.cw.ServiceDeskAPI.Tickets.getTickets({
            conditions: 'id IN (' + ticketIds.join(', ') + ')',
            pageSize: 1000,
        }).then(function (result) {
            let hours = {};
            for (let ticket of result) {
                hours[ticket.id] = round15(ticket.budgetHours - ticket.actualHours);
            }
            return hours;
        });
    }

    findSlot(hours, totalHours) {
        let date = this.date;
        const current = this.existing[date.format('YYYY-MM-DD')];
        if (!current) {
            // Works as is.
            return {
                date,
                hours,
            };
        }

        // Don't break a >= 1 hour task into tiny chunks.  Note: this is in 15-minute increments.
        const minContig = totalHours >= 1 ? 1 * 4 : totalHours * 4;
        let contig = 0;
        let start = moment(date);
        for (let t = 0; t < this.params.daily * 4; ++t) {
            const used = date.format('HH:mm') in current.times;
            if (used && contig >= minContig) {
                // Whether we hit daily, or found enough, let's bail.
                break;
            } else if (used) {
                // Hold out for a longer slice.
                contig = 0;
            } else {
                if (contig == 0) {
                    start = moment(date);
                }
                ++contig;
            }

            date.add(15, 'minutes');
        }

        if (contig >= minContig) {
            // Found a slot, let's use it.
            return {
                date: start,
                hours: Math.min(contig / 4, hours),
            };
        }

        // We didn't find a usable slot.
        return false;
    }

    dispatchSlot(ticketId, slot) {
        Existing.add(this.existing, ticketId, slot.date, slot.hours);

        if (this.params.dry) {
            console.log('DISPATCHING: ', slot.date.format('YYYY-MM-DD HH:mm:ss'), ticketId, 'for ', slot.hours);
            return true;
        } else {
            return this.cw.ScheduleAPI.ScheduleEntries.createSchedule({
                objectId: ticketId,
                member: {
                    identifier: this.params.memberIdentifier,
                },
                dateStart: slot.date.utc().format(),
                dateEnd: moment(slot.date).add(slot.hours, 'hours').utc().format(),
                type: {
                    identifier: 'S',
                },
                span: {
                    identifier: 'N',
                },
                allowScheduleConflictsFlag: true,
                hours: slot.hours,
            });
        }
    }

    dispatchTicket(ticket, ticketHours) {
        let promises = [];

        let remaining = ticket.hours || ticketHours[ticket.id];
        while (remaining > 0.01) {
            // Cap at the daily count, less what's already dispatched.
            let nextHours = Math.min(remaining, this.params.daily - this.currentHours(this.date));

            // Now let's find a contiguous slot.  Might be less than nextHours.
            let slot = this.findSlot(nextHours, remaining);
            if (!slot) {
                // Not enough free time on that day - skip it and try the next one.
                this.nextDate(true);
                continue;
            }

            promises.push(this.dispatchSlot(ticket.id, slot));
            this.nextDate();
            remaining -= slot.hours;
        }

        return Promise.all(promises);
    }
}

module.exports = function (cw, params, existing) {
    let dispatcher = new Dispatcher(cw, params, existing);

    return dispatcher.getTicketHours().then(function (ticketHours) {
        let promises = [];

        for (let ticket of params.tickets) {
            promises.push(dispatcher.dispatchTicket(ticket, ticketHours));
        }

        return Promise.all(promises);
    });
};
