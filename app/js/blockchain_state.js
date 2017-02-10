import _ from 'lodash';
import Web3 from 'web3';
import contract from 'truffle-contract';
import deepEqual from 'deep-equal';
import {EventEmitter2} from 'eventemitter2';
import utils from 'js/utils';
import assert from 'js/assert';
import ValentineRegistryArtifacts from '../../build/contracts/ValentineRegistry.json';
import Web3Wrapper from 'js/web3_wrapper';
import ValentineRequests from 'js/valentine_requests';

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';

class BlockchainState extends EventEmitter2 {
    constructor(onUpdatedFn) {
        super();
        this._onUpdatedFn = onUpdatedFn;
        this._err = null;
        this._isLoaded = false;
        this._wrappedWeb3 = null;
        this._networkId = null;
        this._valentineRegistry = null;
        this._valentineRequests = new ValentineRequests(this._onValentineRequestsUpdated.bind(this));
        this._logValentineRequestCreated = null;
        this._logRequestAccepted = null;
        this._eventNames = utils.keyWords([
            'valentineRequestsUpdated',
        ]);
        this._onPageLoadInitFireAndForgetAsync();
    }
    hasError() {
        return this._err !== null;
    }
    getError() {
        return this._err;
    }
    isLoaded() {
        return this._isLoaded;
    }
    isValidAddress(address) {
        const lowercaseAddress = address.toLowerCase();
        return this._wrappedWeb3.call('isAddress', lowercaseAddress);
    }
    getValentineRequests() {
        return this._valentineRequests.getAll();
    }
    isRequestTargetedAtUser(valentineAddress) {
        return valentineAddress === this._wrappedWeb3.getFirstAccountIfExists() || valentineAddress === NULL_ADDRESS;
    }
    getFirstAccountIfExists() {
        return this._wrappedWeb3.getFirstAccountIfExists();
    }
    async createValentineRequestFireAndForgetAsync(requesterName, valentineName, customMessage, valentineAddress) {
        assert.isString(requesterName);
        assert.isString(valentineName);
        assert.isString(customMessage);
        assert(this.isValidAddress(valentineAddress) || _.isEmpty(valentineAddress), 'valentineAddress \
        must either be a valid ethereum address or an empty string');

        const requesterAddress = this._wrappedWeb3.getFirstAccountIfExists();
        assert(!_.isNull(requesterAddress), 'requesterAddress must be available for a transaction to be sent.');

        const requestOpts = {
            from: requesterAddress,
            value: this._wrappedWeb3.call('toWei', 0.1, 'ether'),
        }
        if (_.isEmpty(valentineAddress)) {
            await this._valentineRegistry.createOpenValentineRequest(requesterName, valentineName,
                customMessage, requestOpts);
        } else {
            await this._valentineRegistry.createTargetedValentineRequest(requesterName, valentineName,
                customMessage, valentineAddress, requestOpts);
        }
    }
    async acceptValentineRequestAsync(requesterAddress) {
        assert(this.isValidAddress(requesterAddress), 'requesterAddress must be valid ethereum address');

        const valentineRequest = this._wrappedWeb3.getFirstAccountIfExists();
        assert(!_.isNull(valentineRequest), 'valentineRequest must be available for a transaction to be sent.');

        await this._valentineRegistry.acceptValentineRequest(requesterAddress, {
            from: valentineRequest,
        });
    }
    async didRequesterAlreadyRequestAsync() {
        const requesterAddress = this._wrappedWeb3.getFirstAccountIfExists();
        assert(!_.isNull(requesterAddress), 'requesterAddress must exist to check for existing requests.');

        const request = await this.getRequestIfExistsAsync(requesterAddress);
        return !_.isNull(request);
    }
    async getRequestIfExistsAsync(address) {
        assert(this.isValidAddress(address), 'address must be valid ethereum address');

        const requestArr = await this._valentineRegistry.getRequestByRequesterAddress.call(address);
        const request = this._convertRequestArrToObj(requestArr);
        if (!this._doesRequestExist(request)) {
            return null;
        }
        return request;
    }
    async _onPageLoadInitFireAndForgetAsync() {
        await this._onPageLoadAsync(); // wait for page to load

        const wrappedExistingWeb3 = new Web3Wrapper(window.web3);
        const doesWeb3InstanceExist = wrappedExistingWeb3.doesExist();
        if (!doesWeb3InstanceExist) {
            // TODO: replace error with backup option i.e infura.io
            this._err = 'NO_WEB3_INSTANCE_FOUND';
            this._isLoaded = true;
            this._onUpdatedFn();
        } else {
            // Create new instance of web3 with only the currentProvider taken from the pre-existing
            // instance so as to not depend on third-party's version of web3.
            const web3Instance = new Web3(wrappedExistingWeb3.get('currentProvider'));
            wrappedExistingWeb3.destroy();
            this._wrappedWeb3 = new Web3Wrapper(web3Instance);
            this._wrappedWeb3.on('networkConnection', this._networkConnectionChangedAsync.bind(this));

            await this._instantiateContractAsync();
        }
    }
    async _instantiateContractAsync() {
        this._networkId = await this._wrappedWeb3.getNetworkIdIfExists();
        const doesNetworkExist = !_.isNull(this._networkId);
        if (doesNetworkExist) {
            const valentineRegistry = await contract(ValentineRegistryArtifacts);
            valentineRegistry.setProvider(this._wrappedWeb3.get('currentProvider'));
            try {
                this._valentineRegistry = await valentineRegistry.deployed();
                await this._getExistingRequestsAsync();
                // this._kickoffFakeRequestAdds();
                this._createFakeRequests(10);
                this._startWatchingContractForEvents();
            } catch(err) {
                const errMsg = `${err}`;
                if (_.includes(errMsg, 'not been deployed to detected network')) {
                    this._err = 'CONTRACT_NOT_DEPLOYED_ON_NETWORK';
                } else {
                    // We show a generic message for other possible caught errors
                    console.log('Unhandled error encountered: ', err);
                    this._err = 'UNHANDLED_ERROR';
                }
            }
        } else {
            this._err = 'DISCONNECTED_FROM_ETHEREUM_NODE';
        }
        this._isLoaded = true;
        this._onUpdatedFn();
    }
    async _getExistingRequestsAsync() {
        this._valentineRequests.clearAll();

        const numRequesters = await this._valentineRegistry.numRequesters.call();
        for(let i = 0; i < numRequesters.toNumber(); i++) {
            const requestArr = await this._valentineRegistry.getRequestByIndex.call(i);
            const request = this._convertRequestArrToObj(requestArr);
            this._valentineRequests.add(request);
        }
    }
    _getUniqueFakeAddress() {
        const index = 2 + Math.floor((Math.random() * 39) + 1);
        const letterIndex = Math.floor((Math.random() * 51) + 1);
        const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const letter = letters[letterIndex];
        let address = NULL_ADDRESS;
        address = address.substr(0, index) + letter + address.substr(index+1);;
        return address;
    }
    getFakeName(len) {
        const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let name = '';
        _.times(len, () => {
            const letterIndex = Math.floor((Math.random() * 51) + 1);
            name += letters[letterIndex];
        });
        return name;
    }
    _createFakeRequests(num) {
        _.times(num, () => {
            this._createFakeRequest();
        });
    }
    _kickoffFakeRequestAdds() {
        setInterval(() => {
            this._createFakeRequest();
        }, 2000);
    }
    _createFakeRequest() {
        const request = {
            requesterName: this.getFakeName(10),
            valentineName: this.getFakeName(12),
            customMessage: this.getFakeName(20),
            wasAccepted: false,
            valentineAddress: NULL_ADDRESS,
            requesterAddress: this._getUniqueFakeAddress(),
        };
        this._valentineRequests.add(request);
    }
    _startWatchingContractForEvents() {
        // Ensure we are only ever listening to one set of events
        if (!_.isNull(this._logValentineRequestCreated)) {
            this._logValentineRequestCreated.stopWatching();
        }
        if (!_.isNull(this._logRequestAccepted)) {
            this._logRequestAccepted.stopWatching();
        }

        this._logValentineRequestCreated = this._valentineRegistry.LogValentineRequestCreated({}, 'latest');
        this._logValentineRequestCreated.watch((err, result) => {
            if (err) {
                console.log('Warning: An error occured while listening to LogValentineRequestCreated events:', err);
                return;
            }
            const request = result.args;
            request.wasAccepted = false;

            if (!this._valentineRequests.has(request.requesterAddress)) {
                this._valentineRequests.add(request);
            }
        });

        this._logRequestAccepted = this._valentineRegistry.LogRequestAccepted({}, 'latest');
        this._logRequestAccepted.watch((err, result) => {
            if (err) {
                console.log('Warning: An error occured while listening to LogRequestAccepted events:', err);
                return;
            }
            const eventData = result.args;

            if (this._valentineRequests.has(eventData.requesterAddress)) {
                this._valentineRequests.update(eventData.requesterAddress, 'wasAccepted', true);
            }
        });
    }
    async _networkConnectionChangedAsync(networkIdIfExists) {
        const isConnected = !_.isNull(networkIdIfExists);
        if (!isConnected) {
            this._err = 'DISCONNECTED_FROM_ETHEREUM_NODE';
        } else if(this._networkId !== networkIdIfExists) {
            this._err = '';
            await this._instantiateContractAsync();
            // TODO: perhaps add a snackbar notifying user of the network change
        }
        this._networkId = networkIdIfExists;
        this._onUpdatedFn();
    }
    async _onPageLoadAsync() {
        return new Promise((resolve,reject) => {
            window.onload = resolve;
        });
    }
    _convertRequestArrToObj(requestArr) {
        const request = {
            requesterName: requestArr[0],
            valentineName: requestArr[1],
            customMessage: requestArr[2],
            wasAccepted: requestArr[3],
            valentineAddress: requestArr[4],
            requesterAddress: requestArr[5],
        };
        return request;
    }
    _doesRequestExist(request) {
        const emptyRequestArr = ['', '', '', false, NULL_ADDRESS, NULL_ADDRESS];
        return !deepEqual(request, this._convertRequestArrToObj(emptyRequestArr));
    }
    _onValentineRequestsUpdated() {
        this.emit(this._eventNames.valentineRequestsUpdated);
    }
}

export default BlockchainState;
