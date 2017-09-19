'use strict';

const moment = require('moment-timezone');
const Existing = require('./existing');
const promiseReflect = require('promise-reflect');

function round15(hours) {
    // Round to 15 minutes.
    return Math.round(hours * 4) / 4;
}

class Dispatcher {
    constructor(cw, params, existing) {
        this.cw = cw;
        this.params = params;
        this.existing = existing;
        this.ticketDetail = null;

        this.totalRemaining = this.params.capTotalHours || (this.daily * 365);
        this.date = moment(params.startDate).tz(params.timezone);
        this.existingHours = Existing.combinedTicketHours(existing);
        this.endDate = params.endDate ? moment(params.endDate).tz(params.timezone).endOf('day') : false;
        this.nextDate();
    }

    get daily() {
        return this.params.daily || 8;
    }

    nextDate(force) {
        if (force) {
            // Maybe this day has a little time free, but not enough.  Skip.
            this.date.add(1, 'days');
        }
        this.date = this.beginDay(this.findDay(this.date));
    }

    dateValid() {
        return !this.endDate || this.date.diff(this.endDate) < 0;
    }

    beginDay(date) {
        return date.hour(this.params.startHour).minute(0).second(0);
    }

    currentHours(date) {
        const current = this.existing[date.format('YYYY-MM-DD')];
        return current ? current.hours : 0;
    }

    findDay(start) {
        let date = moment(start);
        // Skip weekends.
        while (this.currentHours(date) >= this.daily || date.day() == 0 || date.day() == 6) {
            date = date.add(1, 'days');
        }
        return date;
    }

    getTicketHours() {
        return this.getTicketDetail().then(detail => {
            let hours = {};
            for (let ticketId in detail) {
                const ticket = detail[ticketId];
                hours[ticketId] = this.ticketActive(ticket) ? round15(ticket.budgetHours - ticket.actualHours) : 0;
            }
            return hours;
        });
    }

    ticketActive(ticket) {
        // Both SEG and Project statuses.
        const inactive = [
            'canceled',
            'client uat',
            'closed',
            'code review',
            'complete',
            'completed',
            'done yet?',
            'enter time',
            'internal qa',
            'on-hold',
            'pending code review',
            'pending deployment',
            'ready for qa',
            'requested info',
            'waiting',
            'waiting on client',
        ];

        const status = String(ticket.status.name).toLowerCase();
        if (this.params.skipByStatus === true) {
            return inactive.indexOf(status) === -1;
        } else if (this.params.skipByStatus === false) {
            return true;
        } else if (Array.isArray(this.params.skipByStatus)) {
            return this.params.skipByStatus.indexOf(status) != -1;
        } else {
            return status == this.params.skipByStatus;
        }
    }

    getTicketDetail() {
        const ticketIds = this.params.tickets.map(t => t.id);
        let promise = new Promise((resolve) => resolve(this.ticketDetail));

        return promise.then(detail => {
            if (detail) {
                return detail;
            }

            return this.cw.ServiceDeskAPI.Tickets.getTickets({
                conditions: 'id IN (' + ticketIds.join(', ') + ')',
                pageSize: 1000,
            }).then(result => {
                let tickets = {};
                for (let ticket of result) {
                    if (!('actualHours' in ticket)) {
                        ticket.actualHours = 0;
                    }
                    tickets[ticket.id] = ticket;
                }

                this.ticketDetail = tickets;
                return tickets;
            });
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
        for (let t = 0; t < this.daily * 4; ++t) {
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
            return new Promise(resolve => resolve(true));
        } else {
            const start = moment.tz(slot.date, this.params.timezone);
            const end = moment.tz(slot.date, this.params.timezone).add(slot.hours, 'hours');

            return this.cw.ScheduleAPI.ScheduleEntries.createSchedule({
                objectId: ticketId,
                member: {
                    identifier: this.params.memberIdentifier,
                },
                dateStart: start.utc().format(),
                dateEnd: end.utc().format(),
                type: {
                    identifier: 'S',
                },
                span: {
                    identifier: 'N',
                },
                allowScheduleConflictsFlag: true,
                hours: slot.hours,
            }).then(result => {
                if (this.params.setAssigned) {
                    return this.cw.ServiceDeskAPI.Tickets.updateTicket(ticketId, [
                        {op: 'replace', path: 'status', value: {name: 'Assigned'}},
                    ]).then(() => true, e => {
                        console.log('Failed to set assigned status on ticket', ticketId, e);
                        throw e;
                    });
                }

                return true;
            }, e => {
                console.log('Failed to dispatch ticket', ticketId, e);
                throw e;
            });
        }
    }

    dispatchTicket(ticket, ticketHours) {
        let promises = [];

        let remaining = Math.min(this.totalRemaining, ticket.hours || ticketHours[ticket.id]);
        remaining = this.applyDuplicateCheck(ticket, remaining);

        while (this.dateValid() && remaining > 0.01) {
            // Cap at the daily count, less what's already dispatched.
            let nextHours = Math.min(remaining, this.daily - this.currentHours(this.date));

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
            this.totalRemaining -= slot.hours;
        }

        return Promise.all(promises.map(promiseReflect));
    }

    applyDuplicateCheck(ticket, remaining) {
        if (this.params.skipDuplicateMode === 'ignore') {
            return remaining;
        }

        if (ticket.id in this.existingHours) {
            if (this.params.skipDuplicateMode === 'skip') {
                return 0;
            } else if (this.params.skipDuplicateMode === 'subtract') {
                return remaining - this.existingHours[ticket.id];
            } else {
                throw new Error('Invalid skip duplicate mode: ' + this.params.skipDuplicateMode);
            }
        }

        // Ticket wasn't a duplicate anyway.
        return remaining;
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
