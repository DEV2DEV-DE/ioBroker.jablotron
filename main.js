'use strict';

/*
 * Created with @iobroker/create-adapter v2.5.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;

const baseUrl = 'https://api.jablonet.net/api/2.2';

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
		this.sessionId = '';
		this.refreshInterval = undefined;
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
				this.sessionId = await this.fetchSessionId(this.config.username, this.config.password);
				this.connected = this.sessionId !== '';
			} catch (error) {
				this.log.error(error);
			}
		}

		if (this.connected) {
			this.refreshInterval = setInterval(() => {
			}, this.config.pollInterval * 1000);
			// subscribe to all state changes
			// this.subscribeStates('status.alarm');
		}


	}

	/**
	 * Login to jablonet.net
	 * @param {string} username
	 * @param {string} password
	 */
	async fetchSessionId(username, password) {
		try {
			const url = `${baseUrl}/userAuthorize.json`;
			const data = {
				'login': username,
				'password': password
			};
			const headers = {
				'x-vendor-id': 'JABLOTRON:Jablotron',
				'Content-Type': 'application/json',
				'x-client-version': 'MYJ-PUB-ANDROID-12',
				'accept-encoding': '*',
				'Accept': 'application/json',
				'Accept-Language': 'en'
			};
			const response = await axios.post(url, data, { headers });
			if (!this.sessionId) this.log.info('Logged in to jablonet api');
			const cookie = response.headers['set-cookie'];
			if (cookie) {
				const sessionId = cookie.toString().split(';')[0];
				this.log.debug('Session-ID: ' + sessionId);
				await this.parseResponse(response.data['service-data']);
				return sessionId;
			} else {
				this.log.error('No session id found');
				return '';
			}
		} catch (error) {
			this.log.error(error);
			return '';
		}
	}

	async getCurrentStatus() {
		this.fetchSessionId(this.config.username, this.config.password);
	}

	async parseResponse(data) {
		if (data) {
			const serviceDetail = data['service-detail'];
			for (const key in serviceDetail) {
				console.log(`Key: ${key}, Value: ${serviceDetail[key]}`);
				await this.setObjectNotExistsAsync(`service.${key}`, { type: 'state', common: { name: `${key}`, type: 'string', role: 'state', read: true, write: false}, native: {},});
				await this.setStateAsync(`service.${key}`, `${serviceDetail[key]}`, true);
			}
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			clearInterval(this.refreshInterval);
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