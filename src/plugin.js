import streamDeck, { LogLevel } from "@elgato/streamdeck";
/** @typedef {import("@elgato/streamdeck").Logger} Logger */
/** @typedef {import("@elgato/streamdeck").SystemDidWakeUpEvent} SystemDidWakeUpEvent */

const logger = streamDeck.logger.createScope("Plugin");
// logger.setLevel(LogLevel.TRACE);

import { AVRTracker } from "./modules/tracker";
AVRTracker.setLogger(logger);

import { VolumeAction } from "./actions/volume";
import { PowerAction } from "./actions/power";
import { SourceAction } from "./actions/source";


/** @typedef {import("./modules/connection").AVRConnection} AVRConnection */

/**
 * Plugin-level context for actions to access
 * @typedef {Object} PluginContext
 * @property {Record<ReceiverUUID, AVRConnection>} avrConnections - Maps receiver UUIDs to connections
 * @property {Logger} logger - Logger instance
 */

/** @typedef {string} ReceiverUUID */

/** @type {PluginContext} */
const plugin = {
    avrConnections: {},
    logger
};

streamDeck.actions.registerAction(new VolumeAction(plugin));
streamDeck.actions.registerAction(new PowerAction(plugin));
streamDeck.actions.registerAction(new SourceAction(plugin));

// Connect to the StreamDeck and kick-off the rest of the initialization
await streamDeck.connect();

// Start the SSDP/UPnP tracker and perform a scan if no receivers are found in the cache
await AVRTracker.listen();
if (Object.keys(AVRTracker.getReceivers()).length === 0) {
    // Perform a quick initial scan, followed by a longer scan on startup so that existing actions can connect
    // Between the two scans, that should cover fast (wired) connections as well as slower (wireless) connections
    AVRTracker.searchForReceivers(1, 1)
        .then(() => AVRTracker.searchForReceivers(3, 3));
}

// When the system wakes up, we need to re-connect to receivers
streamDeck.system.onSystemDidWakeUp(() => {
    logger.info("System woke up, refreshing connections.");
    Object.values(plugin.avrConnections).forEach(connection => {
        connection.disconnect();
        connection.connect();
    });
});