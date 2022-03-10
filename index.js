const fs = require('fs');
const {Client, Intents, MessageEmbed} = require('discord.js');

const config = JSON.parse(fs.readFileSync('./config.json').toString('utf8'));
const client = new Client({intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.GUILD_MESSAGE_REACTIONS]});

async function main() {
    let channel;

    client.on('ready', async () => {
        console.log('Logged in successfully!');
        channel = await client.channels.fetch(config.channel_id);

        // Cache old event messages, add any new reactions, and queue up event starting
        let data = await loadData();
        let emojis = data.emojis;
        for (let i=0; i<data.events.length; i++) {
            let event = data.events[i];
            let msgID = event.messageID;

            let message = await channel.messages.fetch(msgID);
            if (!message) {
                // This message got deleted! Remove the event
                console.log('Hm... It seems the discord message for this event got deleted. Cancelling event...');
                data.events.splice(i, 1);
                i--;
                continue;
            }
            
            for (let messageReaction of message.reactions.cache) {
                messageReaction = messageReaction[1];
                let emoji = messageReaction._emoji.toString();

                let roleName = Object.keys(emojis)[Object.values(emojis).indexOf(emoji)];
                if (!roleName) continue;

                // This emoji is a role emoji! Check if any users are missing from data
                let users = await messageReaction.users.fetch();
                let idList = [];
                for (let user of users) {
                    user = user[1];
                    if (user.id != client.user.id) idList.push(user.id);
                }

                // Add any ids which are not in the event data
                for (let i=0; i<idList.length; i++) {
                    let id = idList[i];
                    if (event.entries.findIndex(entry => entry.id == id) == -1) {
                        console.log(`Adding User: ${id} to Role: ${roleName} for Dungeon: ${event.dungeonName} who reacted while bot was offline`);
                        addEntry(event, id, roleName);
                    }
                }

                // Remove any ids which are in the event data but are no longer reacting
                for (let i=event.entries.length-1; i>=0; i--) {
                    let entry = event.entries[i];
                    let id = entry.id;
                    let idListIndex = idList.indexOf(id);
                    if (idListIndex == -1) {
                        console.log(`Removing User: ${id} from Role: ${roleName} for Dungeon: ${event.dungeonName} who un-reacted while bot was offline`);
                        removeEntry(event, id, roleName);
                    }
                }
            }

            scheduleEvent(event, channel);
        }

        await saveData(data); // Save the new data
    });
    

    // Add listeners
    client.on('messageCreate', async message => {
        if (message.channelId != config.channel_id) return;

        let content = message.content;
        let chunks = commandParser(content);

        if (chunks[0] != config.command_prefix) return; // Ignore if this message doesn't start with the prefix
        console.log('Handling command: ' + JSON.stringify(chunks));
        
        let embed = new MessageEmbed();
        let sendError = msg => {
            console.log('Error: ' + msg);
            embed.setTitle('Error');
            embed.setColor('RED');
            embed.setDescription(msg);
            channel.send({embeds: [embed]});
        }

        try {
            switch (chunks[1]) {
                case 'create':
                    let dungeonName = chunks[2];
                    let startTime = chunks[3];

                    if (!dungeonName) {
                        sendError('Missing dungeon name!');
                        return;
                    }
                    if (!startTime) {
                        sendError('Missing start time!');
                        return;
                    }

                    let date = new Date(startTime);
                    if (date == 'Invalid Date') {
                        sendError('Invalid start time format!');
                        return;
                    }
                    if (Number(date) < Date.now()) {
                        sendError('Start time cannot be in the past!');
                        return;
                    }

                    // Create the event
                    let event = {
                        dungeonName,
                        startTime: Number(date),
                        entries: [],
                        messageID: undefined
                    };

                    // Check that this event doesn't already exist
                    let data = await loadData();
                    for (let i=0; i<data.events.length; i++) {
                        let testEvent = data.events[i];
                        if (testEvent.dungeonName == event.dungeonName && testEvent.startTime == event.startTime) {
                            // This event already exists!
                            sendError('An identical event has already been created!');
                            return;
                        }
                    }

                    // Build title
                    let title = replaceKeywords(config.announcement_message, {'dungeon': dungeonName, 'time': formatDate(date)});

                    // Build description
                    let emojis = data.emojis;
                    let description = `React with these emojis to pick a role!\n${emojis['DPS']} - DPS\n${emojis['Tank']} - Tank\n${emojis['Support']} - Support`;

                    // Send message
                    embed.setColor('GREEN');
                    embed.setTitle(title);
                    embed.setDescription(description);
                    let sentMessage = await channel.send({embeds: [embed]});

                    // Delete the original message
                    await message.delete();
                    
                    // Add reactions
                    for (key in emojis) {
                        await new Promise((resolve, reject) => setTimeout(resolve, 500)); // Delay 500 ms
                        let emoji = emojis[key];
                        await sentMessage.react(emoji);
                    }

                    // Save this event to data file
                    event.messageID = sentMessage.id;
                    data.events.push(event);
                    await saveData(data);

                    // Schedule this event
                    scheduleEvent(event, channel);

                    // Send success to console
                    console.log('Successfully created new event for Dungeon: ' + dungeonName + ' at Time: ' + date.toLocaleString());
                    break;
                case 'forcestart':
                    // Start the most recent event
                    let startData = await loadData();
                    if (startData.events.length == 0) return;

                    let startingEvent = startData.events[startData.events.length-1];
                    await startEvent(startingEvent, channel);
                    startData.events.splice(startData.length-1, 1);
                    await saveData(startData);
                    break;
                case 'reset':
                    await resetEvents(channel);
                    embed.setColor('GREEN');
                    embed.setTitle('Resetting Events');
                    embed.setDescription('Success!');
                    await channel.send({embeds: [embed]});
                    break;
                case 'config':
                    console.log('Configuring new emojis...');
                    let newEmojis = {'DPS': undefined, 'Tank': undefined, 'Support': undefined};
                    embed.setColor('GREEN');
                    embed.setTitle('Configuring Emojis');
                    embed.setDescription('');
                    embed.setFooter({text: 'Warning: This will cancel any current events'});

                    let configMsg = await channel.send({embeds: [embed]});

                    for (let role in newEmojis) {
                        let newEmbed = new MessageEmbed(embed).setDescription(`React below with the emoji to use for the \`${role}\` role`);
                        configMsg.edit({embeds: [newEmbed]});

                        let options = {max: 1, maxEmojis: 1, maxUsers: 1};
                        let reactions = await configMsg.awaitReactions(options);

                        let setReaction = false;
                        for (let messageReaction of reactions) {
                            newEmojis[role] = messageReaction[1]._emoji.toString();
                            setReaction = true;
                            break;
                        }

                        if (!setReaction) {
                            sendError(`No emoji for role ${role} detected!`);
                        }
                    }
                    await resetEvents(channel);

                    let configData = await loadData();
                    configData.emojis = newEmojis;
                    await saveData(configData);

                    configMsg.edit({embeds: [new MessageEmbed(embed).setDescription('Success!')]})
                    break;
                case 'help':
                    console.log('Displaying help text...');
                    embed.setColor('GREEN');
                    embed.setTitle('Help');
                    let prefix = config.command_prefix;
                    let info = [
                        prefix + ' create "`DUNGEON NAME`" "`DATE/TIME`" - Create a new dungeon event. Example: `' + prefix + ' create "Tomato Town" "July 1, 2022 7:30 pm CST"',
                        prefix + ' forcestart - Forces the most recent scheduled dungeon to start',
                        prefix + ' reset - Automatically cancel all scheduled dungeons',
                        prefix + ' config - Configure which emojis are used for role reactions. (WILL CANCEL ALL SCHEDULED DUNGEONS!)'
                    ];
                    embed.setDescription(info.join('\n\n'));
                    await channel.send({embeds: [embed]});
                    break;
                default:
                    sendError('Unknown command!');
                    break;
            }
        } catch (error) {
            console.log('Command error!');
            console.log(error);
            channel.send({embeds: [new MessageEmbed().setTitle('Command Error').setColor('RED').setDescription('See console for more info.')]});
        }
    });

    client.on('messageReactionAdd', async (messageReaction, user) => {
        if (user.id == client.user.id) return; // Ignore bot reactions

        let data = await loadData();
        let emojis = data.emojis;

        // Check if this is a reaction to an event
        for (let i=0; i<data.events.length; i++) {
            let event = data.events[i];
            if (event.messageID == messageReaction.message.id) {
                let emoji = messageReaction._emoji.toString();

                let roleName = Object.keys(emojis)[Object.values(emojis).indexOf(emoji)];
                if (!roleName) return; // This is a random emoji

                // Add this user to the role
                console.log(`Adding User: ${user.id} to Role: ${roleName} for Dungeon: ${event.dungeonName}`);
                addEntry(event, user.id, roleName);
                break;
            }
        }

        await saveData(data);
    });

    client.on('messageReactionRemove', async (messageReaction, user) => {
        if (user.id == client.user.id) return; // Ignore bot reactions

        let data = await loadData();
        let emojis = data.emojis;

        // Check if this is a reaction to an event
        for (let i=0; i<data.events.length; i++) {
            let event = data.events[i];
            if (event.messageID == messageReaction.message.id) {
                let emoji = messageReaction._emoji.toString();

                let roleName = Object.keys(emojis)[Object.values(emojis).indexOf(emoji)];
                if (!roleName) return; // This is a random emoji

                // Remove this user from the role
                console.log(`Removing User: ${user.id} from Role: ${roleName} for Dungeon: ${event.dungeonName}`);
                removeEntry(event, user.id, roleName);
                break;
            }
        }

        await saveData(data);
    });

    // Log in with the bot token
    await client.login(config.token);
}
main();

const defaultData = {
    emojis: {
        DPS: '😎',
        Tank: '💩',
        Support: '💀'
    },
    events: []
};

async function loadData() {
    try {
        let file = await fs.promises.readFile('./data.json');
        return JSON.parse(file.toString('utf8'));
    } catch (error) {
        return JSON.parse(JSON.stringify(defaultData)); // Make a deep copy
    }
}

function loadDataSync() {
    try {
        let file = fs.readFileSync('./data.json');
        return JSON.parse(file.toString('utf8'));
    } catch (error) {
        return JSON.parse(JSON.stringify(defaultData)); // Make a deep copy
    }
}

async function saveData(data) {
    await fs.promises.writeFile('./data.json', JSON.stringify(data));
}

function saveDataSync(data) {
    fs.writeFileSync('./data.json', JSON.stringify(data));
} 

function commandParser(command) {
    let chunks = [];

    let currentChunk = '';
    let insideQuotes = false;
    for (let x=0; x<command.length; x++) {
        let char = command[x];

        if (char == '"') {
            insideQuotes = !insideQuotes;
            continue;
        }
        if (char == ' ') {
            if (!insideQuotes) {
                chunks.push(currentChunk);
                currentChunk = '';
                continue;
            }
        }
        currentChunk += char;
    }
    chunks.push(currentChunk);

    if (insideQuotes) return undefined; // Parse error!

    return chunks;
}

async function resetEvents(channel) {
    console.log('Resetting events!');
    let data = await loadData();
    
    for (let event of data.events) {
        let message = await channel.messages.fetch(event.messageID);
        if (!message) {
            continue;
        }
        await message.delete();
    }

    data.events = [];

    await saveData(data);
}

async function startEvent(event, channel) {
    console.log(`Starting event for Dungeon: ${event.dungeonName}`);
    // First verify that the message even exists!
    let roleMessage = await channel.messages.fetch(event.messageID);
    if (!roleMessage) return; // Event doesn't exist anymore! Don't display anything.

    // Assign teams
    let entries = event.entries;
    let {
        dps_count: dpsCount,
        tank_count: tankCount,
        support_count: supportCount,
        random_backfilling: randomBackfilling,
        flex_roles: flexRoles,
        scramble_entries: scramble
    } = config;
    let teamSize = dpsCount + tankCount + supportCount;
    
    if (scramble) {
        entries = scrambleList(entries);
    }
    
    let groups = [];
    let flexEnabled = false;
    let randomBackfillingEnabled = false;
    let messyFilling = false;
    let teamsComplete = false;
    while (true) {
        // Try to build teams
        while (true) {
            if (entries.length == 0) {
                // No more entries! Get out and display all assigned teams
                teamsComplete = true;
                break;
            }

            let group = [];
            let requiredRoles = [];
            for (let i=0; i<dpsCount; i++) requiredRoles.push('DPS');
            for (let i=0; i<tankCount; i++) requiredRoles.push('Tank');
            for (let i=0; i<supportCount; i++) requiredRoles.push('Support');

            let madePlacement = false;
            let secondTime = false;
            for (let i=0; i<entries.length; i++) {
                if (requiredRoles.length == 0) break; // No roles left! Move to the next step

                // We have a role to fill! Check if this person can fill it
                let entry = entries[i];
                if (group.findIndex(member => member.id == entry.id) != -1) continue; // This entry has already been added to the group!

                let possibleRoles = entry.roles.filter(role => requiredRoles.indexOf(role) != -1);
                let forcedRole = false;
                if (flexEnabled && secondTime && possibleRoles.length == 0) {
                    // Force this entry to accept a required role
                    possibleRoles = JSON.parse(JSON.stringify(requiredRoles)); // Make a deep copy
                    forcedRole = true;
                } else if (possibleRoles.length == 0) {
                    if (i == entries.length-1 && !secondTime && flexEnabled) {
                        // Enable second time so flex placing starts and reset for loop
                        i = -1;
                        secondTime = true;
                        continue;
                    } 
                    continue; // Skip this user and try the next one
                };

                // Assign a role
                let chosenRole = possibleRoles[Math.floor(Math.random() * possibleRoles.length)];
                requiredRoles.splice(requiredRoles.indexOf(chosenRole), 1); // Remove this role from the required roles
                if (forcedRole) chosenRole = `${chosenRole}(${entry.roles.join('/')})`; // If this role was forced, show preferred roles
                group.push({id: entry.id, role: chosenRole});
                madePlacement = true;

                // Enable second time if group is incomplete
                if (i == entries.length-1 && !secondTime && flexEnabled) {
                    // Enable second time so flex placing starts and reset for loop
                    i = -1;
                    secondTime = true;
                    continue;
                } 
            }

            if (randomBackfillingEnabled && madePlacement && group.length != teamSize) {
                // Complete this team with randoms!
                while (group.length != teamSize) group.push({id: -1, role: requiredRoles.splice(0, 1)[0]});
            }

            if (madePlacement && group.length == teamSize) {
                // Made a complete team! Sort the the team alphabetically by role
                group.sort((a, b) => a.role.localeCompare(b.role));
                groups.push(group);

                // Remove these group members from entries
                for (let member of group) {
                    let entryIndex = entries.findIndex(entry => entry.id == member.id);
                    if (entryIndex != -1) entries.splice(entryIndex, 1);
                }
            } else {
                if (messyFilling) teamsComplete = true; // Unable to fill teams! Leave out whoever didn't make it.

                // Made an incomplete team! Enable alternate filling measures
                messyFilling = true;
                if (flexRoles) flexEnabled = true;
                if (randomBackfilling) randomBackfillingEnabled = true;
                break;
            }
        }

        if (teamsComplete) break;
    }

    // Display the teams
    await roleMessage.delete();
    let keywords = {'dungeon': event.dungeonName, 'time': formatDate(new Date(event.startTime))};
    let embed = new MessageEmbed();
    embed.setColor('GREEN');
    embed.setTitle(replaceKeywords(config.start_message, keywords));

    if (groups.length == 0) {
        // Display no teams message
        embed.setDescription(replaceKeywords(config.empty_message, keywords));
        await channel.send({embeds: [embed]});
        return;
    }

    embed.setDescription(replaceKeywords(config.description_message, keywords));
    let groupNumber = 1;
    for (let group of groups) {
        let fieldTitle = 'Group ' + groupNumber;
        let members = [];
        for (let member of group) {
            let username = '[RANDOM]';
            if (member.id != -1) {
                let user = await client.users.cache.get(member.id);
                await new Promise((resolve, reject) => setTimeout(resolve, 100)); // Delay 100 ms
                username = user.toString();
            }

            members.push(`\`${member.role}\` - ${username}`);
        }
        let fieldValue = members.join('\n');

        embed.addField(fieldTitle, fieldValue, true);
        groupNumber++;
    }

    // Send the role assignments out!
    await channel.send({embeds: [embed]});
}

function replaceKeywords(template, replacements) {
    Object.keys(replacements).forEach(key => {
        let value = replacements[key];
        key = '{' + key + '}';

        while (template.indexOf(key) != -1) template = template.replace(key, value);
    });
    return template;
}

function scrambleList(list) {
    let newList = [];
    for (let entry of list) newList.splice(Math.floor(Math.random() * (newList.length+1)), 0, entry);
    return newList;
}

function addEntry(event, id, role) {
    let entries = event.entries;
    let entryIndex = entries.findIndex(entry => entry.id == id);
    if (entryIndex == -1) {
        entries.push({id, roles: []});
        entryIndex = entries.length-1;
    }

    if (entries[entryIndex].roles.indexOf(role) == -1) {
        // Add this role since it isn't here already
        entries[entryIndex].roles.push(role);
    }
}

function removeEntry(event, id, role) {
    let entries = event.entries;
    let entryIndex = entries.findIndex(entry => entry.id == id);
    if (entryIndex == -1) return;

    let roleIndex = entries[entryIndex].roles.indexOf(role);
    if (roleIndex == -1) return;
    entries[entryIndex].roles.splice(roleIndex, 1);

    if (entries[entryIndex].roles.length == 0) {
        // Remove this entry since they have no roles assigned anymore
        entries.splice(entryIndex, 1);
    }
}

function formatDate(date) {
    return date.toLocaleString('en-us', {timeZone: config.timezone}) + ' ' + config.timezone;
}

function scheduleEvent(event, channel) {
    // Set a timer to start this event
    let delay = event.startTime - Date.now();
    setTimeout(async () => {
        // Verify that the poll message still exists
        console.log(`Time to start an event!`);
        let data = loadDataSync();
        let newEvent = data.events.find(a => a.messageID == event.messageID);
        if (!newEvent) return; // This event doesn't exist anymore
        let pollMsg = await channel.messages.fetch(newEvent.messageID);
        if (pollMsg) {
            await startEvent(newEvent, channel);
        }

        // Remove this event
        let index = data.events.indexOf(newEvent);
        if (index != -1) data.events.splice(index, 1);
        saveDataSync(data);
    }, delay);
    console.log(`Scheduled event for Dungeon: ${event.dungeonName}`);
}