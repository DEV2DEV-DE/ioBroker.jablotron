'use strict';

/*
 * Created with @iobroker/create-adapter v2.5.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;

const EAI_MAX_ERRORS = 5;
const SESSION_LIFETIME = 3600; // 1 hour

const baseUrl = 'https://api.jablonet.net/api/2.2';
const userAgent = 'Mozilla/5.0 (iPhone13,2; U; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/602.1.50 (KHTML, like Gecko) Version/10.0 Mobile/15E148 Safari/602.1';
const headers = {
	'x-vendor-id': 'JABLOTRON:Jablotron',
	'Content-Type': 'application/json',
	'x-client-version': 'MYJ-PUB-ANDROID-12',
	'accept-encoding': '*',
	'Accept': 'application/json',
	'Accept-Language': 'en',
	'User-Agent': userAgent
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
		this.sessionExpires = 0;
		this.timeout = undefined;
		this.states = [];
		this.eai_error = 0;

		axios.defaults.withCredentials = true; // force axios to use cookies
		axios.defaults.timeout = 4000; // set timeout for any request to 4 seconds

		this.on('ready', this.onReady.bind(this));
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
			// the polling interval should never be less than 10 seconds to prevent possisble bans
			if (this.config.pollInterval < 5) throw new Error('Poll interval must be at least 10 seconds');
			// username and password are mandatory
			if (!this.config.username || !this.config.password) throw new Error('Username and password are mandatory');

			this.sessionId = await this.fetchSessionId(this.config.username, this.config.password);
			this.isConnected = this.sessionId !== '';

			// create interval for recurring tasks
			if (this.isConnected) {
				this.sessionExpires = Date.now() + SESSION_LIFETIME * 1000;
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
	async fetchSessionId(username, password, getData = true) {
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
				this.sessionExpires = Date.now() + SESSION_LIFETIME * 1000;
				this.log.debug('Session-ID: ' + sessionId);
				this.log.debug('Fetching initial data from jablonet.net');
				if (getData) await this.getExtendedData(headers, sessionId);
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
	 * Refreshes the session ID by fetching it from the server using the provided username and password.
	 * Updates the isConnected flag and session expiration time accordingly.
	 * @throws {Error} If unable to connect to jablonet.net
	 */
	async refreshSessionId() {
		this.sessionId = await this.fetchSessionId(this.config.username, this.config.password, false);
		this.isConnected = this.sessionId !== '';
		if (this.isConnected) {
			this.sessionExpires = Date.now() + SESSION_LIFETIME * 1000;
		} else {
			throw new Error('Error refreshing session id');
		}
}

	/**
	 * get data from jablonet cloud
	 * @param {object} headers
	 * @param {string} cookie
	 */
	async getExtendedData(headers, cookie) {
		try {
			if (Date.now() > this.sessionExpires) {
				this.log.debug('Session expired. Trying to login again');
				await this.refreshSessionId();
			}
			const services = await this.getServices(headers, cookie);
			if (services && services.length > 0) {
				await this.createFolder('services', 'All services related to the account');
				for (const key in services) {
					const service = services[key];
					const serviceId = service['service-id'];
					await this.createChannel(`services.${serviceId}`, `Service ${serviceId}`);
					for (const state in service) {
						await this.createOrUpdateState(`services.${serviceId}.${state}`, `${state}`, true, false, service[state]);
					}
					if (this.config.readSections) await this.getSections(headers, cookie, serviceId);
					if (this.config.readProgrammableGates) await this.getProgrammableGates(headers, cookie, serviceId);
					if (this.config.readThermoDevices) await this.getThermoDevices(headers, cookie, serviceId);
				}
			} else {
				this.log.debug('No services found');
			}
		} catch (error) {
			if (error.response && error.response.status >= 400) {
				this.log.warn(`Communication error ${error.response.status} (${error.code}). Trying to login again`);
				await this.refreshSessionId();
			} else {
				this.terminate('Error in getExtendedData: ' + error);
			}
		}
	}

	/**
	 * Recursively refreshes data at a specified interval.
	 * @returns {Promise<void>}
	 */
	async recurringRefresh() {
		this.timeout = this.setTimeout(() => {
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
			this.eai_error = 0;
			this.log.debug('serviceListGet: ' + JSON.stringify(response.data));
			return response.data['data']['services'];
		} catch (error) {
			if (error.response && error.response.status === 504 || error.code === 'ECONNABORTED') {
				this.log.debug('Timeout exceeded requesting services');
				return false;
			} else if (error.code === 'EAI_AGAIN' && this.eai_error < EAI_MAX_ERRORS) {
				this.log.debug('DNS-Lookup failed requesting services');
				this.eai_error++;
				return false;
			} else {
				throw error;
			}
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
			this.eai_error = 0;
			this.log.debug('sectionsGet: ' + JSON.stringify(response.data));
			await this.createFolder(`services.${serviceId}.sections`, 'All sections related to the service');
			const sections = response.data['data']['sections'];
			const states = response.data['data']['states'];
			for (const section in sections) {
				const id = sections[section]['cloud-component-id'];
				await this.createChannel(`services.${serviceId}.sections.${id}`, `${id}`);
				for (const key in sections[section]) {
					await this.createOrUpdateState(`services.${serviceId}.sections.${id}.${key}`, `${key}`, true, false, sections[section][key]);
				}
				const state = states.find(state => state['cloud-component-id'] === id);
				if (state) { // es wurde ein state zur section gefunden
					await this.createOrUpdateState(`services.${serviceId}.sections.${id}.state`, 'state', true, false, state.state);
				}
			}
		} catch (error) {
			if (error.response && error.response.status === 504 || error.code === 'ECONNABORTED') {
				this.log.debug('Timeout exceeded requesting sections');
			} else if (error.code === 'EAI_AGAIN' && this.eai_error < EAI_MAX_ERRORS) {
				this.eai_error++;
				this.log.debug('DNS-Lookup failed requesting sections');
			} else {
				throw error;
			}
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
			this.eai_error = 0;
			this.log.debug('programmableGatesGet: ' + JSON.stringify(response.data));
			await this.createFolder(`services.${serviceId}.programmable-gates`, 'All programmable gates related to the service');
			const gates = response.data['data']['programmableGates'];
			const states = response.data['data']['states'];
			for (const gate in gates) {
				const id = gates[gate]['cloud-component-id'];
				await this.createChannel(`services.${serviceId}.programmable-gates.${id}`, `${id}`);
				for (const key in gates[gate]) {
					await this.createOrUpdateState(`services.${serviceId}.programmable-gates.${id}.${key}`, `${key}`, true, false, gates[gate][key]);
					const state = states.find(state => state['cloud-component-id'] === id);
					if (state) { // es wurde ein state zum gate gefunden
						await this.createOrUpdateState(`services.${serviceId}.programmable-gates.${id}.state`, 'state', true, false, state.state);
					}
				}
			}
		} catch (error) {
			if (error.response && error.response.status === 504 || error.code === 'ECONNABORTED') {
				this.log.debug('Timeout exceeded requesting programmableGates');
			} else if (error.code === 'EAI_AGAIN' && this.eai_error < EAI_MAX_ERRORS) {
				this.eai_error++;
				this.log.debug('DNS-Lookup failed requesting programmableGates');
			} else {
				throw error;
			}
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
			this.eai_error = 0;
			this.log.debug('thermoDevicesGet: ' + JSON.stringify(response.data));
		} catch (error) {
			if (error.response && error.response.status === 504 || error.code === 'ECONNABORTED') {
				this.log.debug('Timeout exceeded requesting thermoDevices');
			} else if (error.code === 'EAI_AGAIN' && this.eai_error < EAI_MAX_ERRORS) {
				this.eai_error++;
				this.log.debug('DNS-Lookup failed requesting thermoDevices');
			} else {
				throw error;
			}
		}
	}

	/**
	 * create a folder in the object tree
	 * @param {string} id
	 * @param {string} name
	 */
	async createFolder(id, name) {
		const stateId = this.name2id(id);
		if (!this.existsState(stateId)) {
			await this.extendObjectAsync(stateId, { type: 'folder', common: { name: `${name}` }, native: {}, });
			this.states.push(stateId);
		}
	}

	/**
	 * create a channel in the object tree
	 * @param {string} id
	 * @param {string} name
	 */
	async createChannel(id, name) {
		const stateId = this.name2id(id);
		if (!this.existsState(stateId)) {
			await this.extendObjectAsync(stateId, { type: 'channel', common: { name: `${name}` }, native: {}, });
			this.states.push(stateId);
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
	async createOrUpdateState(id, name, read, write, value) {
		let stateType = '';
		let stateRole = '';
		switch (typeof (value)) {
			case 'object': stateType = 'string';
				stateRole = 'json';
				value = JSON.stringify(value);
				break;
			case 'string': stateType = 'string';
				stateRole = 'text';
				break;
			case 'boolean': stateType = 'boolean';
				stateRole = 'indicator';
				break;
			case 'number': stateType = 'number';
				stateRole = 'value';
				break;
			default: throw new Error('Unknown type for value "' + name + '"');
		}
		const stateId = this.name2id(id);
		if (!this.existsState(stateId)) {
			// @ts-expect-error: False positive. Invalid types will result in an error. There will never be an invalid type here.
			await this.extendObjectAsync(stateId, { type: 'state', common: { name: `${name}`, type: `${stateType}`, role: stateRole, read: read, write: write }, native: {}, });
			this.states.push(stateId);
		}
		await this.setStateAsync(stateId, value, true);
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
	 * Replaces forbidden characters in a name with underscores.
	 * @param {string} name - The name to be processed.
	 * @returns {string} - The processed name with forbidden characters replaced by underscores.
	 */
	name2id(name) {
		return name.replace(this.FORBIDDEN_CHARS, '_');
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