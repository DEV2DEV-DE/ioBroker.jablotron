'use strict';

/*
 * Created with @iobroker/create-adapter v2.5.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;

const EAI_MAX_ERRORS = 12;
const REQUEST_TIMEOUT = 10000; // default timeout for request: 10 seconds

const baseUrl = 'https://api.jablonet.net/api/2.2';
const userAgent = 'Mozilla/5.0 (iPhone13,2; U; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/602.1.50 (KHTML, like Gecko) Version/10.0 Mobile/15E148 Safari/602.1';
const requestHeader = {
	'x-vendor-id': 'JABLOTRON:Jablotron',
	'Content-Type': 'application/json',
	'x-client-version': 'MYJ-PUB-ANDROID-12',
	'accept-encoding': '*',
	'Accept': 'application/json',
	'Accept-Language': 'en',
	'User-Agent': userAgent,
	'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
	'Pragma': 'no-cache',
	'Expires': '0'
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
		this.eai_error = 0;
		this.isReady = false;

		axios.defaults.timeout = REQUEST_TIMEOUT; // set timeout for any request

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
		// only update the state if the adapter is ready (prevent error messages on startup)
		if (this.isReady) this.setState('info.connection', { val: value, ack: true });
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		try {
			// the polling interval should never be less than 5 seconds to prevent possisble bans
			if (this.config.pollInterval < 5) throw new Error('Poll interval must be at least 5 seconds');
			// username and password are mandatory
			if (!this.config.username || !this.config.password) throw new Error('Username and password are mandatory');

			this.isReady = true;
			this.sessionId = await this.fetchSessionId(this.config.username, this.config.password);
			this.isConnected = this.sessionId !== '';

			// create interval for recurring tasks and fetch initial data
			if (this.isConnected) {
				this.log.debug('Fetching initial data from jablonet.net');
				await this.getExtendedData(requestHeader, this.sessionId);
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
			const timestamp = new Date().getTime();
			const url = `${baseUrl}/userAuthorize.json?timestamp=${timestamp}`;
			const data = {
				'login': username,
				'password': password
			};
			this.log.debug('Fetching new session id');
			const response = await axios.post(url, data, { headers: requestHeader });
			if (this.config.logResponse) this.log.debug('Response-Header: ' + JSON.stringify(response.headers));
			if (response.headers && response.headers.has('Set-Cookie')) {
				const cookie = response.headers['set-cookie'];
				if (cookie) {
					this.log.info('Logged in to jablonet api');
					const sessionId = cookie.toString().split(';')[0];
					this.log.debug('Session-ID: ' + sessionId);
					return sessionId;
				} else {
					throw new Error('Login failed. No session id received');
				}
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
		this.sessionId = await this.fetchSessionId(this.config.username, this.config.password);
		this.isConnected = this.sessionId !== '';
		if (!this.isConnected) {
			throw new Error('Error refreshing session id');
		}
	}

	/**
	 * get data from jablonet cloud
	 * @param {object} header
	 * @param {string} cookie
	 */
	async getExtendedData(header, cookie) {
		try {
			const services = await this.getServices(header, cookie);
			if (services && services.length > 0) {
				await this.createFolder('services', 'All services related to the account');
				for (const key in services) {
					await this.createChannel(`services.${key}`, `Service ${key}`);
					const service = services[key];
					const serviceId = service['service-id'];
					await this.createChannel(`services.${serviceId}`, `Service ${serviceId}`);
					for (const state in service) {
						await this.createOrUpdateState(`services.${serviceId}.${state}`, `${state}`, true, false, service[state]);
					}
					if (this.config.readSections) await this.getSections(header, cookie, serviceId);
					if (this.config.readProgrammableGates) await this.getProgrammableGates(header, cookie, serviceId);
					if (this.config.readThermoDevices) await this.getThermoDevices(header, cookie, serviceId);
				}
			} else {
				this.log.debug('No services found');
			}
		} catch (error) {
			if (error.response && error.response.status == 401) {
				this.log.debug('Session expired. Trying to login again');
				// wait to fetch new session id
				this.setTimeout(() => {
					this.refreshSessionId();
				}, 30000);
			} else if (error.response && error.response.status >= 400) {
				this.log.warn(`Communication error ${error.response.status} (${error.code}).`);
			} else {
				this.log.debug('Error in getExtendedData: ' + error);
			}
		}
	}

	/**
	 * Recursively refreshes data at a specified interval.
	 * @returns {Promise<void>}
	 */
	async recurringRefresh() {
		this.timeout = this.setTimeout(() => {
			//this.log.debug('Fetch data from jablonet.net');
			this.getExtendedData(requestHeader, this.sessionId);
			this.recurringRefresh();
		}, this.config.pollInterval * 1000);
	}

	/**
	 * read all services related to the account
	 * @param {object} header
	 * @param {string} cookie
	 */
	async getServices(header, cookie) {
		try {
			const payload = {
				'list-type': 'EXTENDED',
				'visibility': 'DEFAULT'
			};
			header['Cookie'] = cookie;
			const url = `${baseUrl}/JA100/serviceListGet.json`;
			const response = await axios.post(url, payload, { headers: header});
			this.eai_error = 0;
			if (this.config.logResponse) this.log.debug('serviceListGet: ' + JSON.stringify(response.data));
			return response.data['data']['services'];
		} catch (error) {
			if (error.response && error.response.status === 504 || error.code === 'ECONNABORTED') {
				this.log.debug('Timeout exceeded requesting services');
				return null;
			} else if (error.code === 'EAI_AGAIN' && this.eai_error < EAI_MAX_ERRORS) {
				this.log.debug('DNS-Lookup failed requesting services');
				this.eai_error++;
				return null;
			} else {
				throw error;
			}
		}
	}

	/**
	 * read all sections related to a given service
	 * @param {object} header
	 * @param {string} cookie
	 * @param {string} serviceId
	 */
	async getSections(header, cookie, serviceId) {
		try {
			const payload = {
				'connect-device': true,
				'list-type': 'FULL',
				'service-id': serviceId,
				'service-states': true
			};
			header['Cookie'] = cookie;
			const url = `${baseUrl}/JA100/sectionsGet.json`;
			const response = await axios.post(url, payload, { headers: header });
			this.eai_error = 0;
			if (this.config.logResponse) this.log.debug('sectionsGet: ' + JSON.stringify(response.data));
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
	 * @param {object} header
	 * @param {string} cookie
	 * @param {string} serviceId
	 */
	async getProgrammableGates(header, cookie, serviceId) {
		try {
			const payload = {
				'connect-device': true,
				'list-type': 'FULL',
				'service-id': serviceId,
				'service-states': true
			};
			header['Cookie'] = cookie;
			const url = `${baseUrl}/JA100/programmableGatesGet.json`;
			const response = await axios.post(url, payload, { headers: header });
			this.eai_error = 0;
			if (this.config.logResponse) this.log.debug('programmableGatesGet: ' + JSON.stringify(response.data));
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
	 * @param {object} header
	 * @param {string} cookie
	 * @param {string} serviceId
	 */
	async getThermoDevices(header, cookie, serviceId) {
		try {
			const payload = {
				'connect-device': true,
				'list-type': 'FULL',
				'service-id': serviceId,
				'service-states': true
			};
			header['Cookie'] = cookie;
			const url = `${baseUrl}/JA100/thermoDevicesGet.json`;
			const response = await axios.post(url, payload, { headers: header });
			this.eai_error = 0;
			if (this.config.logResponse) this.log.debug('thermoDevicesGet: ' + JSON.stringify(response.data));
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