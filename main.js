'use strict';

/*
 * Created with @iobroker/create-adapter v2.5.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;

const baseUrl = 'https://www.jablonet.net';

class Jablotron extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'jablotron',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));

		this.connected = false;
		axios.defaults.withCredentials = true; // force axios to use cookies
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Create all states needed for the adapter
		await this.createObjectStructure();

		if (!this.connected) {
			try {
				const result = await this.login(this.config.username, this.config.password);
				if (result) this.connected = true;
			} catch (error) {
				this.log.error(error);
			}
		}

		// subscribe to all state changes
		this.subscribeStates('status.alarm');

	}

	/**
	 * Login to jablonet.net
	 * @param {string} username
	 * @param {string} password
	 */
	async login(username, password) {
		try {
			const url = `${baseUrl}/ajax/login.php`;
			const data = {
				'login': encodeURIComponent(username),
				'heslo': encodeURIComponent(password),
				'aStatus': 200,
				'loginType': 'Login'
			};
			const response = await axios.get(url, { params: data });
			this.log.info('Logged in to jablonet.net');
			this.log.debug(JSON.stringify(response));
			return true;
		} catch (error) {
			this.log.error(error);
			return false;
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

			callback();
		} catch (e) {
			callback();
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	async createObjectStructure() {
		await this.setObjectNotExistsAsync('status.alarm', { type: 'state', common: { name: 'Alarm status', type: 'number', role: 'level', read: true, write: true, states: '0:disarm;1:home;2:arm;3:alarm', min: 0, max: 3 }, native: {},});
	}

}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Jablotron(options);
} else {
	// otherwise start the instance directly
	new Jablotron();
}