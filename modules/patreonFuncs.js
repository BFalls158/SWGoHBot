const moment = require("moment-timezone");

module.exports = (Bot, client) => {
    const honPat = 500;
    // Check if a given user is a patron, and if so, return their info
    Bot.getPatronUser = async (userId) => {
        if (!userId) return new Error("Missing user ID");
        if (userId === Bot.config.ownerid || (Bot.config.patrons && Bot.config.patrons.indexOf(userId) > -1)) {
            return {discordID: userId, amount_cents: userId === Bot.config.ownerid ? 1500 : honPat};
        }
        let patron = await Bot.cache.get("swgohbot", "patrons", {discordID: userId});

        if (Array.isArray(patron)) patron = patron[0];
        if (patron && !patron.declined_since) {
            return patron;
        }
    };

    // Get an array of all active patrons
    async function getActivePatrons() {
        let patrons = await Bot.cache.get("swgohbot", "patrons", {});
        patrons = patrons.filter(p => !p.declined_since);
        const others = Bot.config.patrons ? Bot.config.patrons.concat([Bot.config.ownerid]) : [Bot.config.ownerid];
        for (const u of others) {
            const user = patrons.find(p => p.discordID === u);
            if (!user) {
                patrons.push({discordID: u, amount_cents: u === Bot.config.ownerid ? 1500 : honPat});
            }
        }
        return patrons;
    }

    // Get the cooldown
    Bot.getPlayerCooldown = async (authorID) => {
        const patron = await Bot.getPatronUser(authorID);
        if (!patron) {
            return {
                player: 2*60,
                guild:  6*60
            };
        }
        if (patron.amount_cents >= 500) {
            // If they have the $5 tier or higher, they get shorted guild & player times
            return {
                player: 60,
                guild:  3*60
            };
        } else if (patron.amount_cents >= 100) {
            // They have the $1 tier, so they get short player times
            return {
                player: 60,
                guild:  6*60
            };
        } else {
            // If they are not a patron, their cooldown is the default
            return {
                player: 2*60,
                guild:  6*60
            };
        }
    };

    // Check for updated ranks
    Bot.getRanks = async () => {
        const patrons = await getActivePatrons();
        for (const patron of patrons) {
            if (patron.amount_cents < 100) continue;
            const user = await Bot.userReg.getUser(patron.discordID);
            // If they're not registered with anything or don't have any ally codes
            if (!user || !user.accounts.length) continue;

            // If they don't want any alerts
            if (!user.arenaAlert || user.arenaAlert.enableRankDMs === "off") continue;
            const accountsToCheck = JSON.parse(JSON.stringify(user.accounts));

            for (let ix = 0; ix < accountsToCheck.length; ix++) {
                const acc = accountsToCheck[ix];
                // If the user only has em enabled for the primary ac, ignore the rest
                if (((user.accounts.length > 1 && patron.amount_cents < 500) || user.arenaAlert.enableRankDMs === "primary") && !acc.primary) {
                    continue;
                }
                let player;
                try {
                    player = await Bot.swgohAPI.unitStats(acc.allyCode, null, {force: true});
                    if (Array.isArray(player)) player = player[0];
                    // player = await Bot.swgohAPI.fastPlayer(acc.allyCode);
                } catch (e) {
                    // Wait since it won't happen later when something breaks
                    await Bot.wait(750);
                    return Bot.logger.error("Broke in getRanks: " + e.message);
                }
                if (!acc.lastCharRank) {
                    acc.lastCharRank = 0;
                    acc.lastCharClimb = 0;
                }
                if (!acc.lastShipRank) {
                    acc.lastShipRank = 0;
                    acc.lastShipClimb = 0;
                }
                const now = moment();
                if (!user.arenaAlert.arena) user.arenaAlert.arena = "none";
                if (!user.arenaAlert.payoutWarning) user.arenaAlert.payoutWarning = 0;
                if (!player || !player.arena) continue;

                if (player.arena.char && player.arena.char.rank) {
                    if (["both", "char"].includes(user.arenaAlert.arena)) {
                        let then = moment(now).utcOffset(player.poUTCOffsetMinutes).endOf("day").subtract(6, "h");
                        if (then.unix() < now.unix()) {
                            then = moment(now).utcOffset(player.poUTCOffsetMinutes).endOf("day").add(18, "h");
                        }
                        const minTil =  parseInt((then-now)/60/1000);
                        const payoutTime = moment.duration(then-now).format("h[h] m[m]") + " until payout.";

                        const pUser = await client.users.fetch(patron.discordID);
                        if (pUser) {
                            try {
                                if (user.arenaAlert.payoutWarning > 0) {
                                    if (user.arenaAlert.payoutWarning  === minTil) {
                                        pUser.send({embed: {
                                            author: {name: "Arena Payout Alert"},
                                            description: `${player.name}'s character arena payout is in **${minTil}** minutes!\nYour current rank is ${player.arena.char.rank}`,
                                            color: "#00FF00"
                                        }});
                                    }
                                }
                                if (minTil === 0 && user.arenaAlert.enablePayoutResult) {
                                    pUser.send({embed: {
                                        author: {name: "Character arena"},
                                        description: `${player.name}'s payout ended at **${player.arena.char.rank}**!`,
                                        color: "#00FF00"
                                    }});
                                }

                                if (player.arena.char.rank > acc.lastCharRank) {
                                    // DM user that they dropped
                                    pUser.send({embed: {
                                        author: {name: "Character Arena"},
                                        description: `**${player.name}'s** rank just dropped from ${acc.lastCharRank} to **${player.arena.char.rank}**\nDown by **${player.arena.char.rank - acc.lastCharClimb}** since last climb`,
                                        color: "#ff0000",
                                        footer: {
                                            text: payoutTime
                                        }
                                    }});
                                }
                            } catch (e) {
                                Bot.logger.error("Broke getting ranks: " + e);
                            }
                        }
                    }
                    acc.lastCharClimb = acc.lastCharClimb ? (player.arena.char.rank < acc.lastCharRank ? player.arena.char.rank : acc.lastCharClimb) : player.arena.char.rank;
                    acc.lastCharRank = player.arena.char.rank;
                }
                if (player.arena.ship && player.arena.ship.rank) {
                    if (["both", "fleet"].includes(user.arenaAlert.arena)) {
                        let then = moment(now).utcOffset(player.poUTCOffsetMinutes).endOf("day").subtract(5, "h");
                        if (then.unix() < now.unix()) {
                            then = moment(now).utcOffset(player.poUTCOffsetMinutes).endOf("day").add(19, "h");
                        }

                        const minTil =  parseInt((then-now)/60/1000);
                        const payoutTime = moment.duration(then-now).format("h[h] m[m]") + " until payout.";
                        const pUser = await client.users.fetch(patron.discordID);
                        if (pUser) {
                            try {
                                if (user.arenaAlert.payoutWarning > 0) {
                                    if (user.arenaAlert.payoutWarning  === minTil) {
                                        pUser.send({embed: {
                                            author: {name: "Arena Payout Alert"},
                                            description: `${player.name}'s ship arena payout is in **${minTil}** minutes!`,
                                            color: "#00FF00"
                                        }});
                                    }
                                }

                                if (minTil === 0 && user.arenaAlert.enablePayoutResult) {
                                    pUser.send({embed: {
                                        author: {name: "Fleet arena"},
                                        description: `${player.name}'s payout ended at **${player.arena.ship.rank}**!`,
                                        color: "#00FF00"
                                    }});
                                }

                                if (player.arena.ship.rank > acc.lastShipRank) {
                                    pUser.send({embed: {
                                        author: {name: "Fleet Arena"},
                                        description: `**${player.name}'s** rank just dropped from ${acc.lastShipRank} to **${player.arena.ship.rank}**\nDown by **${player.arena.ship.rank - acc.lastShipClimb}** since last climb`,
                                        color: "#ff0000",
                                        footer: {
                                            text: payoutTime
                                        }
                                    }});
                                }
                            } catch (e) {
                                Bot.logger.error("Broke getting ranks: " + e);
                            }
                        }
                    }
                    acc.lastShipClimb = acc.lastShipClimb ? (player.arena.ship.rank < acc.lastShipRank ? player.arena.ship.rank : acc.lastShipClimb) : player.arena.ship.rank;
                    acc.lastShipRank = player.arena.ship.rank;
                }
                if (patron.amount_cents < 500) {
                    user.accounts[user.accounts.findIndex(a => a.primary)] = acc;
                } else {
                    user.accounts[ix] = acc;
                }
                // Wait here in case of extra accounts
                await Bot.wait(750);
            }
            await Bot.userReg.updateUser(patron.discordID, user);
        }
    };

    // Check for updated ranks across up to 50 players
    Bot.shardRanks = async () => {
        const patrons = await getActivePatrons();
        for (const patron of patrons) {
            const compChar = [];  // Array to keep track of allycode, toRank, and fromRank
            const compShip = [];  // Array to keep track of allycode, toRank, and fromRank
            // For each person that qualifies, go through their list
            //   - Check their patreon level and go through their top x ally codes based on the lvl
            //   - check the arena rank
            //   - save that change somewhere
            //   - for each next one, see if someone else had the opposite move

            // user = {
            //     ...
            //     arenaWatch: {
            //         enabled: true/ false,
            //         arena: {
            //             fleet: {
            //                 channel: chID,
            //                 enabled: true/ false
            //             },
            //             char: {
            //                 channel: chID,
            //                 enabled: true/ false
            //             }
            //         }
            //         allycodes: []
            //     }
            // };

            if (patron.amount_cents < 100) continue;
            const user = await Bot.userReg.getUser(patron.discordID);

            // If they're not registered with anything or don't have any ally codes
            if (!user || !user.accounts || !user.accounts.length || !user.arenaWatch) continue;
            const aw = user.arenaWatch;

            // In case they have the old version, update em
            if (!aw.arena.fleet || !aw.arena.char) {
                const flEnabled = ["fleet", "both"].includes(aw.arena) ? true : false;
                const chEnabled = ["char", "both"].includes(aw.arena) ? true : false;
                aw.arena = {};
                aw.arena.fleet = {
                    channel: aw.channel,
                    enabled: flEnabled
                };
                aw.arena.char  = {
                    channel: aw.channel,
                    enabled: chEnabled
                };
            }


            // If they don't want any alerts
            if (!aw.enabled
                || (!aw.arena.fleet.channel && !aw.arena.char.channel)
                || (!aw.arena.fleet.enabled && !aw.arena.char.enabled)) {
                continue;
            }

            let acctCount = 0;
            if      (patron.amount_cents < 500)  acctCount = Bot.config.arenaWatchConfig.tier1;
            else if (patron.amount_cents < 1000) acctCount = Bot.config.arenaWatchConfig.tier2;
            else                                 acctCount = Bot.config.arenaWatchConfig.tier3;

            const accountsToCheck = JSON.parse(JSON.stringify(aw.allycodes.slice(0, acctCount)));
            const allyCodes = accountsToCheck.map(a => a.allyCode ?  a.allyCode : a);
            if (!allyCodes || !allyCodes.length) continue;

            const newPlayers = await Bot.swgohAPI.unitStats(allyCodes, null, {force: true});
            if (allyCodes.length !== newPlayers.length) Bot.logger.error(`Did not get all players! ${allyCodes.length} vs ${newPlayers.length}`);

            // Go through all the listed players, and see if any of them have shifted arena rank
            accountsToCheck.forEach((player, ix) => {
                let newPlayer = newPlayers.find(p => p.allyCode === parseInt(player.allyCode));
                if (!newPlayer) {
                    newPlayer = newPlayers.find(p => p.allyCode === parseInt(player));
                }
                if (!newPlayer) {
                    return;
                }
                if (typeof player === "string") {
                    player = {
                        allyCode: parseInt(player),
                        name: newPlayer.name,
                        lastChar: 0,
                        lastShip: 0
                    };
                }
                if (!player.name) {
                    player.name = newPlayer.name;
                }

                if (!player.lastChar || newPlayer.arena.char.rank !== player.lastChar) {
                    compChar.push({
                        name: player.mention ? `<@${player.mention}>` : newPlayer.name,
                        allyCode: player.allyCode,
                        oldRank: player.lastChar || 0,
                        newRank: newPlayer.arena.char.rank
                    });
                    player.lastChar = newPlayer.arena.char.rank;
                }
                if (!player.lastShip || newPlayer.arena.ship.rank !== player.lastShip) {
                    compShip.push({
                        name: player.mention ? `<@${player.mention}>`: newPlayer.name,
                        allyCode: player.allyCode,
                        oldRank: player.lastShip || 0,
                        newRank: newPlayer.arena.ship.rank
                    });
                    player.lastShip = newPlayer.arena.ship.rank;
                }
                accountsToCheck[ix] = player;
            });

            let charOut = [];
            if (compChar.length && aw.arena.char.enabled) {
                charOut = checkRanks(compChar);
            }

            let shipOut = [];
            if (compShip.length && aw.arena.fleet.enabled) {
                shipOut = checkRanks(compShip);
            }
            const charFields = [];
            const shipFields = [];
            if (charOut.length) {
                charFields.push("**Character Arena:**");
                charFields.push(charOut.map(c => "- " + c).join("\n"));
            }
            if (shipOut.length) {
                shipFields.push("**Fleet Arena:**");
                shipFields.push(shipOut.map(c => "- " + c).join("\n"));
            }
            if (charFields.length || shipFields.length) {
                // console.log(fields.join("\n") + "\n-------------------------------------");
                // If something has changed, update the user & let them know
                user.arenaWatch.allycodes = accountsToCheck;
                await Bot.userReg.updateUser(patron.discordID, user);
                if (aw.arena.char.channel === aw.arena.fleet.channel) {
                    // If they're both set to the same channel, send it all
                    const fields = charFields.concat(shipFields);
                    client.shard.broadcastEval(`
                        const chan = this.channels.cache.get("${aw.arena.char.channel}");
                        if (chan && chan.permissionsFor(this.user.id).has(["VIEW_CHANNEL", "SEND_MESSAGES"])) {
                            chan.send(\`>>> ${fields.join("\n")}\`);
                        }
                    `);
                } else {
                    // Else they each have their own channels, so send em there
                    if (aw.arena.char.channel && aw.arena.char.enabled && charFields.length) {
                        client.shard.broadcastEval(`
                            const chan = this.channels.cache.get("${aw.arena.char.channel}");
                            if (chan && chan.permissionsFor(this.user.id).has(["VIEW_CHANNEL", "SEND_MESSAGES"])) {
                                chan.send(\`>>> ${charFields.join("\n")}\`);
                            }
                        `);
                    }
                    if (aw.arena.fleet.channel && aw.arena.fleet.enabled && shipFields.length) {
                        client.shard.broadcastEval(`
                            const chan = this.channels.cache.get("${aw.arena.fleet.channel}");
                            if (chan && chan.permissionsFor(this.user.id).has(["VIEW_CHANNEL", "SEND_MESSAGES"])) {
                                chan.send(\`>>> ${shipFields.join("\n")}\`);
                            }
                        `);
                    }
                }
            }
        }
    };

    // Compare ranks to see if we have both sides of the fight or not
    function checkRanks(inArr) {
        const checked = [];
        const outArr = [];
        for (let ix = 0; ix < inArr.length; ix++) {
            for (let jx = 0; jx < inArr.length; jx++) {
                const isChecked = checked.includes(inArr[ix].allyCode) || checked.includes(inArr[jx].allyCode);
                if (!isChecked && inArr[ix].oldRank === inArr[jx].newRank && inArr[ix].newRank === inArr[jx].oldRank) {
                    // Then they likely swapped spots
                    if (inArr[ix].oldRank > inArr[ix].newRank) {
                        outArr.push(`${inArr[ix].name} has hit ${inArr[jx].name} down from ${inArr[jx].oldRank} to ${inArr[jx].newRank}`);
                    } else {
                        outArr.push(`${inArr[jx].name} has hit ${inArr[ix].name} down from ${inArr[ix].oldRank} to ${inArr[ix].newRank}`);
                    }

                    // Put the players into the checked array so we can make sure not to log it twice
                    checked.push(inArr[ix].allyCode);
                    checked.push(inArr[jx].allyCode);
                }
            }
        }
        inArr.forEach(player => {
            if (!checked.includes(player.allyCode)) {
                outArr.push(`${player.name} has ${player.oldRank < player.newRank ? "dropped" : "climbed"} from ${player.oldRank} to ${player.newRank}`);
            }
        });
        return outArr;
    }
};
