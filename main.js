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

		this.connected = false;
		this.sessionId = '';
		this.refreshInterval = undefined;
		axios.defaults.withCredentials = true; // force axios to use cookies

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Create all states needed for the adapter
		await this.createObjectStructure();

		try {
			// the polling interval should never be less than 10 secondes
			if (this.config.pollInterval < 10) throw new Error('Poll interval must be at least 10 seconds');
			this.sessionId = await this.fetchSessionId(this.config.username, this.config.password);
			this.connected = this.sessionId !== '';
			if (this.connected) {
				this.setStateAsync('info.connection', { val: true, ack: true });
				this.setForeignState('system.adapter.' + this.namespace + '.alive', true);
			}
		} catch (error) {
			this.log.error(error);
		}

		if (this.connected) {
			this.refreshInterval = setInterval(() => {
				this.getCurrentStatus();
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
			const firstStart = !this.sessionId;
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
			if (firstStart) this.log.debug('Fetching new session id');
			const response = await axios.post(url, data, { headers });
			if (firstStart) this.log.info('Logged in to jablonet api');
			const cookie = response.headers['set-cookie'];
			if (cookie) {
				const sessionId = cookie.toString().split(';')[0];
				const serviceId = response.data['data']['service-data']['service-detail']['service-id'];
				this.log.debug('Session-ID: ' + sessionId);
				await this.parseResponse(response.data['data']['service-data']);
				if (firstStart)	await this.getExtendedData(headers, sessionId, serviceId);
				return sessionId;
			} else {
				this.log.error('No session id found');
				return '';
			}
		} catch (error) {
			this.log.error(error);
			this.connected = false;
			this.setStateAsync('info.connection', { val: false, ack: true });
			this.setForeignState('system.adapter.' + this.namespace + '.alive', false);
			return '';
		}
	}

	async getExtendedData(headers, cookie, serviceId) {
		this.log.debug('Fetching extended data with serviceID: ' + serviceId);
		let payload = {
			'connect-device': true,
			'list-type': 'FULL',
			'service-id': serviceId,
			'service-states': true
		};
		headers['Cookie'] = cookie;
		this.log.debug('Headers: ' + JSON.stringify(headers));
		let url = `${baseUrl}/JA100/sectionsGet.json`;
		let response = await axios.post(url, payload, { headers });
		this.log.debug('sectionsGet: ' + JSON.stringify(response.data));
		url = `${baseUrl}/JA100/programmableGatesGet.json`;
		response = await axios.post(url, payload, { headers });
		this.log.debug('programmableGatesGet: ' + JSON.stringify(response.data));
		url = `${baseUrl}/JA100/thermoDevicesGet.json`;
		response = await axios.post(url, payload, { headers });
		this.log.debug('thermoDevicesGet: ' + JSON.stringify(response.data));
		payload = {
			'list-type': 'EXTENDED',
			'visibility': 'DEFAULT'
		};
		url = `${baseUrl}/JA100/serviceListGet.json`;
		response = await axios.post(url, payload, { headers });
		this.log.debug('serviceListGet: ' + JSON.stringify(response.data));
	}

	async getCurrentStatus() {
		this.fetchSessionId(this.config.username, this.config.password);
	}

	async parseResponse(data) {
		this.log.debug('Parsing response');
		this.log.debug(JSON.stringify(data));
		if (data) {
			const serviceDetail = data['service-detail'];
			for (const key in serviceDetail) {
				console.log(`Key: ${key}, Value: ${serviceDetail[key]}`);
				const objectId = `service.${key}`;
				await this.setObjectNotExistsAsync(objectId, { type: 'state', common: { name: `${key}`, type: 'string', role: 'state', read: true, write: false}, native: {},});
				await this.setStateAsync(objectId, `${serviceDetail[key]}`, true);
			}
			const serviceStates = data['service-states'];
			for (const key in serviceStates) {
				console.log(`Key: ${key}, Value: ${serviceDetail[key]}`);
				const objectId = `info.${key}`;
				await this.setObjectNotExistsAsync(objectId, { type: 'state', common: { name: `${key}`, type: 'string', role: 'state', read: true, write: false}, native: {},});
				await this.setStateAsync(objectId, `${serviceDetail[key]}`, true);
			}
			const states = data['ja100-service-data']['states'];
			const sections = data['ja100-service-data']['sections'];
			if (states && sections) {
				for (const key in sections) {
					const channelId = sections[key]['cloud-component-id'];
					// create a channel for each section
					await this.setObjectNotExistsAsync(channelId, { type: 'channel', common: { name: 'Section'}, native: {},});
					for (const element in sections[key]) {
						const objectId = `${channelId}.${element}`;
						const objectType = typeof(sections[key][element]);
						switch (objectType) {
							case 'boolean': await this.setObjectNotExistsAsync(objectId, { type: 'state', common: { name: element, type: 'boolean', role: 'state', read: true, write: false}, native: {},});
								break;
							case 'number': await this.setObjectNotExistsAsync(objectId, { type: 'state', common: { name: element, type: 'number', role: 'state', read: true, write: false}, native: {},});
								break;
							default: await this.setObjectNotExistsAsync(objectId, { type: 'state', common: { name: element, type: 'string', role: 'state', read: true, write: false}, native: {},});
								break;
						}
						await this.setStateAsync(objectId, sections[key][element], true);
					}
					const state = states.find(state => state['cloud-component-id'] === sections[key]['cloud-component-id']);
					if (state) { // es wurde ein state zur section gefunden
						await this.setObjectNotExistsAsync(`${channelId}.state`, { type: 'state', common: { name: 'state', type: 'string', role: 'state', read: true, write: false}, native: {},});
						await this.setStateAsync(`${channelId}.state`, state.state, true);
					}
				}
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
			this.setStateAsync('info.connection', { val: true, ack: true });
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
		await this.setObjectNotExistsAsync('info.connection', { type: 'state', common: { name: 'Communication with service working', type: 'boolean', role: 'indicator.connected', read: true, write: false}, native: {},});
		this.log.debug('Created static object structure');
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