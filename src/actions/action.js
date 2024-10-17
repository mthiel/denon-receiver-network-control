import streamDeck, { SingletonAction } from "@elgato/streamdeck";
/** @typedef {import("@elgato/streamdeck").Action} Action */
/** @typedef {import("@elgato/streamdeck").ActionContext} ActionContext */
/** @typedef {import("@elgato/streamdeck").WillAppearEvent} WillAppearEvent */
/** @typedef {import("@elgato/streamdeck").WillDisappearEvent} WillDisappearEvent */
/** @typedef {import("@elgato/streamdeck").PropertyInspectorDidAppearEvent} PropertyInspectorDidAppearEvent */
/** @typedef {import("@elgato/streamdeck").PropertyInspectorDidDisappearEvent} PropertyInspectorDidDisappearEvent */
/** @typedef {import("@elgato/streamdeck").DidReceiveSettingsEvent} DidReceiveSettingsEvent */
/** @typedef {import("@elgato/streamdeck").SendToPluginEvent} SendToPluginEvent */

import { DenonAVR } from "../modules/denonavr";
import { HEOSSearch, getReceiverNameFromHost } from "../modules/heos";

/**
 * @typedef {Object} VisibleAction
 * @property {string} id - The ID of the action.
 * @property {string} host - The host address of the associated receiver
 */

/**
 * @typedef {Object} ReceiverInfo
 * @property {string} name - The name of the receiver
 * @property {string} address - The IP address of the receiver
 */

/**
 * Generic action class for the StreamDeck plugin
 * @extends SingletonAction
 * @property {DenonAVR[]} receivers - The list of receivers that this action is connected to.
 */
class PluginAction extends SingletonAction {
	/** @type {DenonAVR[]} */
	static connectedReceivers = [];

	/** @type {VisibleAction[]} */
	static visibleActions = [];

	/** @type {HEOSSearch} */
	static heosSearch;

	/** @type {ReceiverInfo[]} */
	static discoveredReceivers = [];

	/**
	 * Set the PI's ID when it appears.
	 * @param {PropertyInspectorDidAppearEvent} ev - The event object.
	 */
	onPropertyInspectorDidAppear(ev) {
		this.#startSearchingForHEOSReceivers();

		this.getReceiverForAction(ev.action).then((receiver) => {
			if (receiver) {
				this.updateStatusMessage(receiver.statusMsg);
			}
		});
	}

	/**
	 * Clean-up the action settings when it's PI disappears.
	 * @param {PropertyInspectorDidDisappearEvent} ev - The event object.
	 */
	onPropertyInspectorDidDisappear(ev) {
		this.#stopSearchingForHEOSReceivers();

		ev.action.getSettings().then((settings) => {
			settings.statusMsg = "";
			ev.action.setSettings(settings);
		});
	}

	/**
	 * Try to create a new receiver connection (if necessary) before the action will appear.
	 * @param {WillAppearEvent} ev - The event object.
	 */
	onWillAppear(ev) {
		streamDeck.logger.debug(`onWillAppear for action id: ${ev.action.id}`);

		const host = ev.payload.settings.host?.toString();
		if (host) {
			let receiver = PluginAction.connectedReceivers.find((receiver) => receiver.host === host);
			if (receiver) {
				this.associateVisibleActionToReceiver(ev.action, receiver);
			} else {
				this.connectReceiver(ev).then((receiver) => {
					if (receiver) {
						this.associateVisibleActionToReceiver(ev.action, receiver);
					}
				});
			}
		}
	}

	/**
	 * Remove a visible action when it's disappearing.
	 * @param {WillDisappearEvent} ev - The event object.
	 */
	onWillDisappear(ev) {
		this.removeVisibleActionFromReceiver(ev.action);
	}

	/**
	 * Handle a events from the Property Inspector.
	 * @param {SendToPluginEvent} ev - The event object.
	 */
	onSendToPlugin(ev) {
		const { event } = ev.payload;

		switch (event) {
			case "userChoseReceiver":
				this.connectReceiver(ev).then((receiver) => {
					if (receiver) {
						this.associateVisibleActionToReceiver(ev.action, receiver);
					}
				});
				break;
			case "getDiscoveredReceivers":
				this.#getDiscoveredReceivers();
				break;
			default:
				streamDeck.logger.warn(`Received unknown event: ${event}`);
		}
	}

	/**
	 * Associate this action with a receiver, creating a new connection as necessary.
	 * @param {WillAppearEvent | SendToPluginEvent} ev - The event object.
	 * @returns {Promise<DenonAVR | undefined>} The receiver object or undefined in case of error.
	 */
	async connectReceiver(ev) {
		let settings = ev.payload?.settings;
		if (!settings) {
			settings = await ev.action.getSettings();
		}

		if (!settings.host) {
			this.updateStatusMessage("No receiver selected.");
			return;
		}

		let receiver = PluginAction.connectedReceivers.find((receiver) => receiver.host === settings.host);
		if (!receiver) {
			streamDeck.logger.info(`Creating new receiver connection to ${settings.host}.`);
			receiver = new DenonAVR(settings.host, settings.name);
			PluginAction.connectedReceivers.push(receiver);

			// Add event listeners for receiver events
			receiver.on("status", (ev) => this.onReceiverStatusChange(ev));
			receiver.on("connected", (ev) => this.onReceiverConnected(ev));
			receiver.on("closed", (ev) => this.onReceiverDisconnected(ev));
			receiver.on("powerChanged", (ev) => this.onReceiverPowerChanged(ev));
			receiver.on("volumeChanged", (ev) => this.onReceiverVolumeChanged(ev));
			receiver.on("muteChanged", (ev) => this.onReceiverMuteChanged(ev));
		}

		this.updateStatusMessage(receiver.statusMsg);

		return receiver;
	}

	/**
	 * Get the receiver object for an action.
	 * @param {Action} action - The action object.
	 * @returns {Promise<DenonAVR | undefined>} The receiver object or undefined if not found.
	 */
	async getReceiverForAction(action) {
		const settings = await action.getSettings();
		return PluginAction.connectedReceivers.find((receiver) => receiver.host === settings.host);
	}

	/**
	 * Associate a visible action with a receiver.
	 * @param {Action} action - The action object.
	 * @param {DenonAVR} receiver - The receiver object.
	 */
	associateVisibleActionToReceiver(action, receiver) {
		// Remove any existing visible actions with the same ID
		PluginAction.visibleActions = PluginAction.visibleActions.filter((visibleAction) => visibleAction.id !== action.id);
		// Add this visible action
		PluginAction.visibleActions.push({ id: action.id, host: receiver.host });
	}

	/**
	 * Remove a visible action from the list of visible actions.
	 * @param {Action | ActionContext} action - The action object.
	 */
	removeVisibleActionFromReceiver(action) {
		PluginAction.visibleActions = PluginAction.visibleActions.filter((visibleAction) => visibleAction.id !== action.id);
	}

	/**
	 * Get a list of detected receivers on the network and send it to the PI.
	 */
	#getDiscoveredReceivers() {
		const discoveredReceivers = PluginAction.discoveredReceivers;

		if (discoveredReceivers.length === 0) {
			return;
		}

		const addressList = [
			{
				label: "Select a receiver",
				value: ""
			},
			...discoveredReceivers.map((discoveredReceiver) => ({
				label: discoveredReceiver.name,
				value: discoveredReceiver.address
			}))
		];

		streamDeck.ui.current?.sendToPropertyInspector({
			event: "getDiscoveredReceivers",
			items: addressList
		});
	}

	/**
	 * Start searching for HEOS receivers on the network.
	 */
	#startSearchingForHEOSReceivers() {
		PluginAction.discoveredReceivers = [];

		let heosSearch = PluginAction.heosSearch;

		if (!heosSearch || heosSearch.destroyed) {
			heosSearch = new HEOSSearch();
			heosSearch.on("response", (address) => { this.#onHEOSResponse(address); });
			PluginAction.heosSearch = heosSearch;
		}

		// Give the event loop a chance to init sockets, if needed. Then start searching.
		setImmediate(() => { heosSearch.startSearching(); });
	}

	/**
	 * Handle a HEOS response.
	 * @param {string} address - The IP address of the HEOS receiver.
	 */
	#onHEOSResponse(address) {
		const existingReceiver = PluginAction.discoveredReceivers.find((receiver) => receiver.address === address);
		if (existingReceiver && existingReceiver.name !== address) {
			return;
		}

		getReceiverNameFromHost(address)
			.then((name) => {
				PluginAction.discoveredReceivers.push({ name: name || address, address: address });
				this.#getDiscoveredReceivers();
			});
	}

	/**
	 * Stop searching for HEOS receivers on the network.
	 */
	#stopSearchingForHEOSReceivers() {
		PluginAction.heosSearch?.stopSearching();
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
	 * Fires when the receiver's status changes and updates the action's PI status message.
	 * @param {DenonAVR} receiver - The receiver object.
	 */
	onReceiverStatusChange(receiver) {
		this.updateStatusMessage(receiver.statusMsg);
	}

	/**
	 * Fires when the receiver connects and updates the action's PI status message.
	 * @param {DenonAVR} receiver - The receiver object.
	 */
	onReceiverConnected(receiver) {
		this.updateStatusMessage(receiver.statusMsg);
	}

	/**
	 * Fires when the receiver disconnects and updates the action's PI status message.
	 * @param {DenonAVR} receiver - The receiver object.
	 */
	onReceiverDisconnected(receiver) {
		this.updateStatusMessage(receiver.statusMsg);
	}

	/**
	 * Fires when the receiver's power state changes.
	 * @param {DenonAVR} receiver - The receiver object.
	 */
	onReceiverPowerChanged(receiver) {}

	/**
	 * Fires when the receiver's volume changes.
	 * @param {DenonAVR} receiver - The receiver object.
	 */
	onReceiverVolumeChanged(receiver) {}

	/**
	 * Fires when the receiver's mute state changes.
	 * @param {DenonAVR} receiver - The receiver object.
	 */
	onReceiverMuteChanged(receiver) {}
}

export { PluginAction };