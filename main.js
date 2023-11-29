'use strict';

/*
 * Created with @iobroker/create-adapter v2.5.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;

const baseUrl = 'https://api.jablonet.net/api/2.2';
const headers = {
	'x-vendor-id': 'JABLOTRON:Jablotron',
	'Content-Type': 'application/json',
	'x-client-version': 'MYJ-PUB-ANDROID-12',
	'accept-encoding': '*',
	'Accept': 'application/json',
	'Accept-Language': 'en'
};

class Jablotron extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'jablotron',
		});

		this.isConnected = false;
		this.sessionId = '';
		this.timeout = undefined;
		this.states = [];

		axios.defaults.withCredentials = true; // force axios to use cookies
		axios.defaults.timeout = 5000; // set timeout for any request to 5 seconds

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Getter for the connected property.
	 * @returns {boolean} The connection status.
	 */
	get isConnected() {
		return this._isConnected || false;
	}
	/**
	 * Setter for the connected property.
	 * @param {boolean} value - The new value for the connected property.
	 */
	set isConnected(value) {
		this._isConnected = value;
		this.setState('info.connection', { val: value, ack: true });
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		try {
			// Create all states needed for the adapter
			await this.createObjectStructure();

			// the polling interval should never be less than 10 seconds to prevent possisble bans
			if (this.config.pollInterval < 10) throw new Error('Poll interval must be at least 10 seconds');
			// username and password are mandatory
			if (!this.config.username || !this.config.password) throw new Error('Username and password are mandatory');

			this.sessionId = await this.fetchSessionId(this.config.username, this.config.password);
			this.isConnected = this.sessionId !== '';

			// create interval for recurring tasks
			if (this.isConnected) {
				this.log.debug('Setting up recurring refresh');
				this.recurringRefresh();
				// subscribe to all state changes
				// this.subscribeStates('status.alarm');
			} else {
				throw new Error('Not connect to jablonet.net');
			}
		} catch (error) {
			this.log.error('Error in onReady: ' + error);
			this.isConnected = false;
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
			this.log.debug('Fetching new session id');
			const response = await axios.post(url, data, { headers });
			this.log.info('Logged in to jablonet api');
			const cookie = response.headers['set-cookie'];
			if (cookie) {
				const sessionId = cookie.toString().split(';')[0];
				this.log.debug('Session-ID: ' + sessionId);
				this.log.debug('Fetching initial data from jablonet.net');
				await this.getExtendedData(headers, sessionId);
				return sessionId;
			} else {
				throw new Error('No session id received');
			}
		} catch (error) {
			this.log.error(error);
			this.isConnected = false;
			return '';
		}
	}

	/**
	 * get data from jablonet cloud
	 * @param {object} headers
	 * @param {string} cookie
	 */
	async getExtendedData(headers, cookie) {
		try {
			const services = await this.getServices(headers, cookie);
			await this.createFolder('services', 'All services related to the account');
			for (const key in services) {
				const service = services[key];
				const serviceId = service['service-id'];
				await this.createChannel(`services.${serviceId}`, `Service ${serviceId}`);
				for (const state in service) {
					await this.createState(`services.${serviceId}.${state}`, `${state}`, true, false, service[state]);
				}
				await this.getSections(headers, cookie, serviceId);
				await this.getProgrammableGates(headers, cookie, serviceId);
				//await this.getThermoDevices(headers, cookie, serviceId);
			}
		} catch (error) {
			this.log.error('getExtendedData: ' + error);
			throw error;
		}
	}

	/**
	 * Recursively refreshes data at a specified interval.
	 * @returns {Promise<void>}
	 */
	async recurringRefresh() {
		this.timeout = setTimeout(() => {
			this.log.debug('Fetch data from jablonet.net');
			this.getExtendedData(headers, this.sessionId);
			this.recurringRefresh();
		}, this.config.pollInterval * 1000);
	}

	/**
	 * read all services related to the account
	 * @param {object} headers
	 * @param {string} cookie
	 */
	async getServices(headers, cookie) {
		try {
			const payload = {
				'list-type': 'EXTENDED',
				'visibility': 'DEFAULT'
			};
			headers['Cookie'] = cookie;
			const url = `${baseUrl}/JA100/serviceListGet.json`;
			const response = await axios.post(url, payload, { headers });
			this.log.debug('serviceListGet: ' + JSON.stringify(response.data));
			return response.data['data']['services'];
		} catch (error) {
			this.log.error('getServices: ' + error);
			throw error;
		}
	}

	/**
	 * read all sections related to a given service
	 * @param {object} headers
	 * @param {string} cookie
	 * @param {string} serviceId
	 */
	async getSections(headers, cookie, serviceId) {
		try {
			const payload = {
				'connect-device': true,
				'list-type': 'FULL',
				'service-id': serviceId,
				'service-states': true
			};
			headers['Cookie'] = cookie;
			const url = `${baseUrl}/JA100/sectionsGet.json`;
			const response = await axios.post(url, payload, { headers });
			this.log.debug('sectionsGet: ' + JSON.stringify(response.data));
			await this.createFolder(`services.${serviceId}.sections`, 'All sections related to the service');
			const sections = response.data['data']['sections'];
			const states = response.data['data']['states'];
			for (const section in sections) {
				const id = sections[section]['cloud-component-id'];
				await this.createChannel(`services.${serviceId}.sections.${id}`, `${id}`);
				for (const key in sections[section]) {
					await this.createState(`services.${serviceId}.sections.${id}.${key}`, `${key}`, true, false, sections[section][key]);
				}
				const state = states.find(state => state['cloud-component-id'] === id);
				if (state) { // es wurde ein state zur section gefunden
					await this.createState(`services.${serviceId}.sections.${id}.state`, 'state', true, false, state.state);
				}
			}
		} catch (error) {
			this.log.error('getSections: ' + error);
			throw error;
		}
	}

	/**
	 * read all programmable gates related to a given service
	 * @param {object} headers
	 * @param {string} cookie
	 * @param {string} serviceId
	 */
	async getProgrammableGates(headers, cookie, serviceId) {
		try {
			const payload = {
				'connect-device': true,
				'list-type': 'FULL',
				'service-id': serviceId,
				'service-states': true
			};
			headers['Cookie'] = cookie;
			const url = `${baseUrl}/JA100/programmableGatesGet.json`;
			const response = await axios.post(url, payload, { headers });
			this.log.debug('programmableGatesGet: ' + JSON.stringify(response.data));
			await this.createFolder(`services.${serviceId}.programmable-gates`, 'All programmable gates related to the service');
			const gates = response.data['data']['programmableGates'];
			const states = response.data['data']['states'];
			for (const gate in gates) {
				const id = gates[gate]['cloud-component-id'];
				await this.createChannel(`services.${serviceId}.programmable-gates.${id}`, `${id}`);
				for (const key in gates[gate]) {
					await this.createState(`services.${serviceId}.programmable-gates.${id}.${key}`, `${key}`, true, false, gates[gate][key]);
					const state = states.find(state => state['cloud-component-id'] === id);
					if (state) { // es wurde ein state zum gate gefunden
						await this.createState(`services.${serviceId}.programmable-gates.${id}.state`, 'state', true, false, state.state);
					}
				}
			}
		} catch (error) {
			this.log.error('getProgrammableGates: ' + error);
			throw error;
		}
	}

	/**
	 * read all thermo devices related to a given service
	 * currently work in prograss due to missing examples
	 * @param {object} headers
	 * @param {string} cookie
	 * @param {string} serviceId
	 */
	async getThermoDevices(headers, cookie, serviceId) {
		try {
			const payload = {
				'connect-device': true,
				'list-type': 'FULL',
				'service-id': serviceId,
				'service-states': true
			};
			headers['Cookie'] = cookie;
			const url = `${baseUrl}/JA100/thermoDevicesGet.json`;
			const response = await axios.post(url, payload, { headers });
			this.log.debug('thermoDevicesGet: ' + JSON.stringify(response.data));
		} catch (error) {
			this.log.error('getThermoDevices: ' + error);
			throw error;
		}
	}

	/**
	 * create a folder in the object tree
	 * @param {string} id
	 * @param {string} name
	 */
	async createFolder(id, name) {
		if (!this.existsState(id)) {
			await this.extendObjectAsync(id, { type: 'folder', common: { name: `${name}` }, native: {}, });
			this.states.push(id);
		}
	}

	/**
	 * create a channel in the object tree
	 * @param {string} id
	 * @param {string} name
	 */
	async createChannel(id, name) {
		if (!this.existsState(id)) {
			await this.extendObjectAsync(id, { type: 'channel', common: { name: `${name}` }, native: {}, });
			this.states.push(id);
		}
	}

	/**
	 * create a state in the object tree and set its value
	 * @param {string} id
	 * @param {string} name
	 * @param {boolean} read
	 * @param {boolean} write
	 * @param {any} value
	 */
	async createState(id, name, read, write, value) {
		let type = undefined;
		let role = 'state';
		switch (typeof (value)) {
			case 'object': type = 'object';
				value = JSON.stringify(value);
				break;
			case 'string': type = 'string';
				role = 'text';
				break;
			case 'boolean': type = 'boolean';
				role = 'indicator';
				break;
			case 'number': type = 'number';
				role = 'value';
				break;
			default: throw new Error('Unknown type for value "' + name + '"');
		}
		if (!this.existsState(id)) {
			await this.extendObjectAsync(id, { type: 'state', common: { name: `${name}`, type: `${type}`, role: role, read: read, write: write }, native: {}, });
			this.states.push(id);
		}
		await this.setStateAsync(id, value, true);
	}

	/**
	 * Checks if a state with the given ID exists.
	 * @param {string} id - The ID of the state to check.
	 * @returns {boolean} - True if the state exists, false otherwise.
	 */
	existsState(id) {
		return this.states.indexOf(id) >= 0;
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	async onUnload(callback) {
		try {
			await this.setState('info.connection', { val: false, ack: true });
			if (this.timeout) await this.clearTimeout(this.timeout);
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
		await this.setObjectNotExistsAsync('info.connection', { type: 'state', common: { name: 'Communication with service working', type: 'boolean', role: 'indicator.connected', read: true, write: false }, native: {}, });
		await this.setObjectNotExistsAsync('blubb', { type: 'folder', common: { name: 'Bli bla blubb' }, native: {}, });
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