import streamDeck, { SingletonAction } from "@elgato/streamdeck";
/** @typedef {import("@elgato/streamdeck").Action} Action */
/** @typedef {import("@elgato/streamdeck").Logger} Logger */
/** @typedef {import("@elgato/streamdeck").ActionContext} ActionContext */
/** @typedef {import("@elgato/streamdeck").WillAppearEvent} WillAppearEvent */
/** @typedef {import("@elgato/streamdeck").WillDisappearEvent} WillDisappearEvent */
/** @typedef {import("@elgato/streamdeck").PropertyInspectorDidAppearEvent} PropertyInspectorDidAppearEvent */
/** @typedef {import("@elgato/streamdeck").SendToPluginEvent} SendToPluginEvent */

/** @typedef {import("../plugin").PluginContext} PluginContext */
/** @typedef {import("../modules/connection").ReceiverEvent} ReceiverEvent */

import { AVRConnection } from "../modules/connection";
import { AVRTracker } from "../modules/tracker";
/** @typedef {import("../modules/tracker").ReceiverList} ReceiverList */
/** @typedef {import("../modules/tracker").ReceiverInfo} ReceiverInfo */

/**
 * @typedef {Object} ReceiverDetail
 * @property {ReceiverUUID} uuid - The receiver UUID
 * @property {number} [zone] - The zone to control on the receiver
 */
/** @typedef {string} ActionUUID */
/** @typedef {string} ReceiverUUID */
/** @typedef {Record<ActionUUID, ReceiverDetail>} ActionReceiverMap */

/**
 * @typedef {Object} ActionSettings
 * @property {string} [uuid] - The receiver UUID to associate with this action
 * @property {string} [name] - The name of the receiver to display in the PI
 * @property {string} [statusMsg] - The connection status message to display in the PI
 * @property {number} [zone] - The zone to control on the receiver
 * @property {string} [volumeAction] - The volume action to perform on the receiver
 * @property {number} [volumeLevel] - The target volume level to set on the receiver
 * @property {string} [powerAction] - The power action to perform on the receiver
 * @property {string} [sourceAction] - The source action to perform on the receiver
 * @property {string} [source] - The source to set on the receiver
 */

/**
 * Base action class for the plugin
 * @extends SingletonAction
 */
export class PluginAction extends SingletonAction {
	/** @type {PluginContext} - Plugin-level context */
	plugin;

	/** @type {Logger} */
	logger;

	get avrConnections() { return this.plugin.avrConnections; }

	/**
	 * Map of actions to their associated receiver UUIDs.
	 * Note: This is also used as a list of connections that this class instance is already listening to.
	 * @type {ActionReceiverMap}
	 */
	actionReceiverMap = {};

	/**
	 * @param {PluginContext} plugin - Plugin-level context to bind to this class
	 */
	constructor(plugin) {
		super();

		// Assign the plugin context to the class, if it wasn't already
		if (!this.plugin) {
			this.plugin = plugin;
			this.logger = plugin.logger.createScope(this.constructor.name);
		}
	}

	/**
	 * Handle the PI appearing
	 * @param {PropertyInspectorDidAppearEvent} ev - The event object.
	 */
	onPropertyInspectorDidAppear(ev) {
		this.syncConnectionStatusToAction();
	}

	/**
	 * Handles checking if an appearing action has a receiver selected already and
	 * attempts to put it in the correct state.
	 * @param {WillAppearEvent} ev - The event object.
	 */
	async onWillAppear(ev) {
		// Check for a selected receiver for this action.
		const receiverId = ev.payload.settings.uuid?.toString();
		if (!receiverId) {
			// No receiver selected, clean-up any existing associations
			delete this.actionReceiverMap[ev.action.id];
			return;
		}

		const zone = /** @type {number} */ (ev.payload.settings.zone) || 0;

		// If a connection doesn't exist yet, try to create one
		if (receiverId in this.avrConnections === false) {
			// Should we wait for the tracker to be updated first?
			if (AVRTracker.isScanning()) {
				// Wait for the scan to complete and try again in case the receiver was found
				AVRTracker.once("scanned", () => this.onWillAppear(ev));
				return;
			}

			// Try to open the new connection to this receiver
			if (await this.connectReceiver(receiverId) === undefined) {
				return;
			}
		}

		// Update the map with the selected receiver ID for this action
		this.actionReceiverMap[ev.action.id] = {
			uuid: receiverId,
			zone: zone
		};
	}

	/**
	 * Handle events from the Property Inspector.
	 * @param {SendToPluginEvent} ev - The event object.
	 */
	onSendToPlugin(ev) {
		const { event } = ev.payload;

		switch (event) {
			case "userChoseReceiver":
				this.onUserChoseReceiver(ev);
				break;
			case "refreshReceiverList":
				this.onRefreshReceiversForPI(ev);
				break;
		}
	}

	/**
	 * Handle a user choosing a receiver from the PI.
	 * @param {SendToPluginEvent} ev - The event object.
	 */
	async onUserChoseReceiver(ev) {
		/** @type {ActionSettings} */
		const settings = await ev.action.getSettings();
		const zone = /** @type {number} */ (settings.zone) || 0;

		let statusMsg = "";

		if (settings.uuid) {
			// Connect to the receiver if the user chose one
			if (settings.uuid in this.avrConnections === false) {
				// No connection yet, try to connect to the receiver
				const connection = await this.connectReceiver(settings.uuid);
				if (connection !== undefined) {
					// Add the connection to the map if we were successful
					this.actionReceiverMap[ev.action.id] = {
						uuid: settings.uuid,
						zone: zone
					};
					statusMsg = connection.status.statusMsg;
				} else {
					// If we failed to connect, clear the association
					delete this.actionReceiverMap[ev.action.id];
					statusMsg = "Can't find receiver";
				}
			} else {
				// We already have a connection, so just update the receiver map
				this.actionReceiverMap[ev.action.id] = {
					uuid: settings.uuid,
					zone: zone
				};
				statusMsg = this.avrConnections[settings.uuid].status.statusMsg;
			}
		} else {
			// Ensure the receiver association is cleared if no receiver is selected
			delete this.actionReceiverMap[ev.action.id];
			statusMsg = "No receiver selected";
		}

		this.updateStatusMessage(statusMsg);
	}

	/**
	 * Handle a request from the PI to refresh the receiver list
	 * @param {SendToPluginEvent} ev 
	 */
	async onRefreshReceiversForPI(ev) {
		/** @type {ReceiverList} */
		let receivers = AVRTracker.getReceivers();

		/** @type {Array<{label: string, value: ReceiverUUID}>} */
		let options;

		// If the user wants a refresh, or if there are no receivers cached,
		// actively attempt to scan for receivers now.
		const settings = await ev.action.getSettings();
		if (ev.payload.isRefresh === true || (!settings.uuid && Object.keys(receivers).length === 0)) {
			// Perform a short scan for receivers
			receivers = await AVRTracker.searchForReceivers(1, 2);
		}

		// Convert the dict stricture into options
		options = [
			{
				label: receivers && Object.keys(receivers).length > 0
					? "Select a receiver"
					: "No receivers detected",
				value: ""
			},
			...Object.entries(receivers).map(([uuid, receiver]) => ({
				label: receiver.name || receiver.currentIP,
				value: uuid
			}))
		];

		streamDeck.ui.current?.sendToPropertyInspector({
			event: "refreshReceiverList",
			items: options
		});

		this.syncConnectionStatusToAction();
	}

	/**
	 * Create a new receiver connection (if necessary) and return it.
	 * @param {string} receiverId - The receiver UUID.
	 * @returns {Promise<AVRConnection | undefined>}
	 */
	async connectReceiver(receiverId) {
		// Check for an existing connection before creating a new one
		if (receiverId in this.avrConnections === false) {
			// Get the receiver info from the tracker
			const receiverInfo = AVRTracker.getReceivers()[receiverId];
			if (!receiverInfo) {
				return;
			}

			this.logger.info(`Creating new receiver connection to ${receiverInfo.name || receiverInfo.currentIP}.`);
			const connection = new AVRConnection(this.plugin, receiverId, receiverInfo.currentIP);
			this.avrConnections[receiverId] = connection;

			// Set up listener for receiver events
			this.avrConnections[receiverId].on(this.routeReceiverEvent.bind(this));
		}

		return this.avrConnections[receiverId];
	}

	/**
	 * Route a receiver event to the appropriate handler.
	 * @param {ReceiverEvent} ev - The event object.
	 */
	routeReceiverEvent(ev) {
		// Get the list of actions to inform of the event and add them to the event object
		ev.actions = this.actions.toArray().filter((action) =>
			this.actionReceiverMap[action.id]?.uuid === ev.connection.uuid &&
			this.actionReceiverMap[action.id]?.zone === ev.zone
		);

		switch (ev.type) {
			case "connected":
				this.onReceiverConnected(ev);
				break;
			case "closed":
				this.onReceiverDisconnected(ev);
				break;
			case "powerChanged":
				this.onReceiverPowerChanged(ev);
				break;
			case "volumeChanged":
				this.onReceiverVolumeChanged(ev);
				break;
			case "muteChanged":
				this.onReceiverMuteChanged(ev);
				break;
			case "status":
				this.onReceiverStatusChange(ev);
				break;
		}
	}

	/**
	 * Update the status message for an action's PI.
	 * @param {string} newStatusMsg - The new status message.
	 */
	updateStatusMessage(newStatusMsg) {
		const action = streamDeck.ui.current?.action;
		if (action) {
			action.getSettings().then((settings) => {
				settings.statusMsg = newStatusMsg;
				action.setSettings(settings);
			});
		}
	}

	/**
	 * Sync the connection status to an action's PI.
	 */
	syncConnectionStatusToAction() {
		const action = streamDeck.ui.current?.action;
		let statusMsg = "";

		if (action && action.id in this.actionReceiverMap) {
			statusMsg = this.avrConnections[this.actionReceiverMap[action.id].uuid]?.status.statusMsg || "";
		}

		this.updateStatusMessage(statusMsg);
	}

	/**
	 * Fires when the receiver's status changes and updates the action's PI status message.
	 * @param {ReceiverEvent} ev - The event object.
	 */
	onReceiverStatusChange(ev) {
		this.updateStatusMessage(ev.connection.status.statusMsg);
	}

	/**
	 * Fires when the receiver connects and updates the action's PI status message.
	 * @param {ReceiverEvent} ev - The event object.
	 */
	onReceiverConnected(ev) {
		this.updateStatusMessage(ev.connection.status.statusMsg);
	}

	/**
	 * Fires when the receiver disconnects and updates the action's PI status message.
	 * @param {ReceiverEvent} ev - The event object.
	 */
	onReceiverDisconnected(ev) {
		this.updateStatusMessage(ev.connection.status.statusMsg);

		// If the receiver is disconnected, show an alert on the actions that are associated with it
		ev.actions?.forEach((action) => {
			action.showAlert();
		});
	}

	/**
	 * Fires when the receiver's power state changes.
	 * @param {ReceiverEvent} ev - The event object.
	 */
	onReceiverPowerChanged(ev) {}

	/**
	 * Fires when the receiver's volume changes.
	 * @param {ReceiverEvent} ev - The event object.
	 */
	onReceiverVolumeChanged(ev) {}

	/**
	 * Fires when the receiver's mute state changes.
	 * @param {ReceiverEvent} ev - The event object.
	 */
	onReceiverMuteChanged(ev) {}
}
