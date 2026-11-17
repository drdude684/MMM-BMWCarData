/* MMM-BMWCarData node_helper
 *
 * Patched for compatibility with older MagicMirror (2.9.x, Electron 3 / Node 10):
 *  - falls back to console when the "logger" module alias is not available
 *  - uses node-fetch when the global fetch() is not available
 *  - generates a fresh PKCE verifier/challenge for every login
 *  - requests EV-specific descriptors (BMW iX3 Neue Klasse / BEVs) and parses values null-safe
 *  - vehicle image download is optional (failure no longer blocks the login flow)
 */
const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let Log;
try {
  Log = require("logger");
} catch (e) {
  Log = console;
}

const fetchFn = (typeof fetch === "function") ? fetch : require("node-fetch");

var loggingLevel = 0; // 0: critical, 1: normal, 2: detailed

const bmwApiRoutes = {
  getDeviceCode: {type: 'POST', url: 'https://customer.bmwgroup.com/gcdm/oauth/device/code', headers: {Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'}, addToken: false},
  getToken: {type: 'POST', url: 'https://customer.bmwgroup.com/gcdm/oauth/token', headers: {Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'}, addToken: false},
  createContainer: {type: 'POST', url: 'https://api-cardata.bmwgroup.com/customers/containers', headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'x-version': 'v1'}, addToken: true},
  deleteContainer: {type: 'DELETE', url: 'https://api-cardata.bmwgroup.com/customers/containers', headers: {Accept: '*/*', 'x-version': 'v1'}, addToken: true},
  listContainers: {type: 'GET', url: 'https://api-cardata.bmwgroup.com/customers/containers', headers: {Accept: 'application/json', 'x-version': 'v1'}, addToken: true},
  readVehicleData: {type: 'GET', url: 'https://api-cardata.bmwgroup.com/customers/vehicles', headers: {Accept: 'application/json', 'x-version': 'v1'}, addToken: true},
};

const containerName = 'MM_data';
// Scopes requested at login. The module only uses the REST API; the streaming scope is optional and
// makes BMW reject the login (400 invalid_request) if "CarData Stream" is not enabled for the client ID.
const defaultScope = 'authenticate_user openid cardata:api:read'; // name for our container in BMW's CarData API

// Descriptors requested in the container. Availability varies per model; missing ones come back as null.
const technicalDescriptors = [
  // general
  "vehicle.vehicle.travelledDistance",
  "vehicle.cabin.door.lock.status",
  "vehicle.drivetrain.lastRemainingRange",
  // fuel (ICE / PHEV)
  "vehicle.drivetrain.fuelSystem.remainingFuel",
  "vehicle.drivetrain.fuelSystem.level",
  // electric (BEV / PHEV)
  "vehicle.drivetrain.electricEngine.kombiRemainingElectricRange",
  "vehicle.drivetrain.electricEngine.charging.level",
  "vehicle.drivetrain.batteryManagement.header",
  "vehicle.powertrain.electric.battery.stateOfCharge.displayed",
  "vehicle.powertrain.electric.battery.stateOfCharge.target",
  "vehicle.powertrain.electric.range.target",
  "vehicle.drivetrain.electricEngine.charging.status",
  "vehicle.drivetrain.electricEngine.charging.hvStatus",
  "vehicle.drivetrain.electricEngine.charging.timeRemaining",
  "vehicle.body.chargingPort.status",
  "vehicle.trip.segment.end.drivetrain.batteryManagement.hvSoc",
];

var sessionInfoFile = null;
var containerAttached = {};

function saveSession(self) {
  fs.writeFile(sessionInfoFile, JSON.stringify(self.sessionInfo), err => { if (err) { log(0, err); } });
}

module.exports = NodeHelper.create({
  start: function () {
    log(0, "Starting node_helper for module: " + this.name);
    this.sessionInfo = {};
    this.config = {};
    this.bmwInfo = {};

    sessionInfoFile = path.join(this.path, 'bmw_session_info.json');
    log(1, `attempting to load session info from file ${sessionInfoFile}`);
    try {
      if (fs.existsSync(sessionInfoFile)) {
        this.sessionInfo = JSON.parse(fs.readFileSync(sessionInfoFile, 'utf8')) || {};
      }
    } catch (e) {
      log(0, `could not read ${sessionInfoFile}: ${e.message}`);
      this.sessionInfo = {};
    }
  },

  socketNotificationReceived: async function (notification, payload) {
    var self = this;
    var vin = payload.vin;
    if (notification == "MMM-BMWCARDATA-CONFIG") {
      log(1, 'config received from module');
      self.config[vin] = payload;
      if (payload.loggingLevel !== undefined)
        loggingLevel = payload.loggingLevel;
      if (self.sessionInfo[vin] && self.sessionInfo[vin].client_id && self.sessionInfo[vin].client_id !== payload.clientId) {
        log(0, 'client ID changed since last login, a new authorization will be required');
        self.sessionInfo[vin] = {};
      }
      if (!self.sessionInfo[vin])
        self.sessionInfo[vin] = {};
      self.sessionInfo[vin].client_id = payload.clientId;
      self.bmwInfo[vin] = {error: null};
    } else if (notification == "MMM-BMWCARDATA-GET") {
      if (self.busy && self.busy[vin]) {
        log(1, 'update already in progress for ' + vin + ', skipping');
        return;
      }
      self.busy = self.busy || {};
      self.busy[vin] = true;
      try {
        await self.updateVehicle(payload);
      } catch (e) {
        log(0, 'unexpected error while updating: ' + (e && e.stack ? e.stack : e));
      }
      self.busy[vin] = false;
    }
  },

  updateVehicle: async function (payload) {
    const vin = payload.vin;
    log(1, 'Updating data for ' + vin);
    const res = await getTelematicData(this, vin);
    if (!res || !res.data || !res.data.telematicData) {
      log(0, 'no telematic data received, nothing sent to module');
      if (!this.bmwInfo[vin] || !this.bmwInfo[vin].updateTime)
        this.sendSocketNotification("MMM-BMWCARDATA-RESPONSE" + payload.instanceId, {error: 'No data from BMW yet, see MagicMirror log.'});
      return;
    }
    log(1, 'telematic data: ' + JSON.stringify(res.data));
    const t = res.data.telematicData;
    const info = this.bmwInfo[vin] || {};

    const lock = val(t, "vehicle.cabin.door.lock.status");
    info.doorLock = (lock === 'SECURED' || lock === 'LOCKED');
    info.doorLockKnown = (lock !== null);
    info.mileage = num(t, "vehicle.vehicle.travelledDistance");
    info.electricRange = num(t, "vehicle.drivetrain.electricEngine.kombiRemainingElectricRange");
    if (info.electricRange === null)
      info.electricRange = num(t, "vehicle.powertrain.electric.range.target");
    info.chargingLevelHv = firstNum(t, [
      "vehicle.powertrain.electric.battery.stateOfCharge.displayed",
      "vehicle.drivetrain.batteryManagement.header",
      "vehicle.drivetrain.electricEngine.charging.level",
    ]);
    info.chargingTarget = num(t, "vehicle.powertrain.electric.battery.stateOfCharge.target");
    // lastRemainingRange is the total range; for a BEV it equals the electric range, so only use it as fuel range if fuel data exists
    const fuelLevel = num(t, "vehicle.drivetrain.fuelSystem.level");
    const remainingFuel = num(t, "vehicle.drivetrain.fuelSystem.remainingFuel");
    info.totalRange = num(t, "vehicle.drivetrain.lastRemainingRange");
    info.fuelRange = (fuelLevel || remainingFuel) ? info.totalRange : null;

    const chargingStatus = String(val(t, "vehicle.drivetrain.electricEngine.charging.status") || val(t, "vehicle.drivetrain.electricEngine.charging.hvStatus") || '').toUpperCase();
    const portStatus = String(val(t, "vehicle.body.chargingPort.status") || '').toUpperCase();
    info.charging = /CHARGINGACTIVE|^CHARGING$/.test(chargingStatus);
    info.connectorStatus = info.charging || (portStatus.indexOf('CONNECTED') !== -1 && portStatus.indexOf('DISCONNECTED') === -1);
    info.chargingStatus = chargingStatus || null;
    info.chargingTimeRemaining = num(t, "vehicle.drivetrain.electricEngine.charging.timeRemaining");

    const imageFile = path.join(this.path, 'car-' + vin + '.png');
    info.imageUrl = fs.existsSync(imageFile) ? 'modules/MMM-BMWCarData/car-' + vin + '.png' : null;
    info.updateTime = Date.now();
    info.error = null;
    this.bmwInfo[vin] = info;
    log(2, 'sending to module: ' + JSON.stringify(info));
    this.sendSocketNotification("MMM-BMWCARDATA-RESPONSE" + payload.instanceId, info);
  },
});

function val(t, key) {
  if (!t || !t[key] || t[key].value === undefined || t[key].value === null || t[key].value === '')
    return null;
  return t[key].value;
}

function num(t, key) {
  const v = val(t, key);
  if (v === null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function firstNum(t, keys) {
  for (var i = 0; i < keys.length; i++) {
    const n = num(t, keys[i]);
    if (n !== null) return n;
  }
  return null;
}

function log(level, message) {
  if (level <= loggingLevel)
    Log.log('MMM-BMWCarData helper: ' + message);
}

function sendError(self, error) {
  log(0, 'message sent to module: ' + error);
  self.sendSocketNotification("MMM-BMWCARDATA-ERROR", error);
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAccessToken(self, vin) {
  log(1, 'getAccessToken() called');
  const s = self.sessionInfo[vin];
  const currentTime = Date.now();
  if (!s || !s.token_expiry || !s.refresh_token || (s.refresh_expiry < currentTime)) {
    log(0, 'no valid refresh token, interactive authorization on the BMW portal is required');
    let res = await getDeviceCode(self, vin);
    if (!res || !res.data)
      return {error: 'could not obtain device code'};
    saveSession(self);
    const uri = res.data.verification_uri_complete || res.data.verification_uri;
    log(0, `Please visit ${uri} within the next ${res.data.expires_in} seconds, log in (if required), and enter the following code: ${res.data.user_code}`);
    sendError(self, `Authorization required. Visit <br>${res.data.verification_uri}<br> within ${res.data.expires_in} seconds<br>Code: ${res.data.user_code}`);
    res = await getFirstToken(self, vin, res.data);
    if (!res || !res.data) {
      sendError(self, 'BMW authorization not completed. Will retry at next refresh.');
      return {error: 'could not obtain first token'};
    }
    // vehicle image is optional
    try {
      await getVehicleImage(self, vin);
    } catch (e) {
      log(0, 'could not retrieve vehicle image: ' + e.message);
    }
    res = await attachContainer(self, vin, true); // on re-authentication, re-create the container so it contains what we expect
    if (!res || !res.data)
      return {error: 'could not create container'};
    sendError(self, ''); // clear the authorization instructions
    log(0, 'BMW authorization successful');
    return {data: self.sessionInfo[vin].access_token};
  }
  if (s.token_expiry < currentTime + 60 * 1000) {
    log(1, 'access token expired, refreshing');
    const res = await refreshToken(self, vin);
    if (!res || !res.data)
      return {error: 'could not refresh token'};
    return {data: s.access_token};
  }
  return {data: s.access_token};
}

async function getDeviceCode(self, vin) {
  log(1, 'getDeviceCode() called');
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  self.sessionInfo[vin].code_verifier = verifier;
  const body = new URLSearchParams({
    client_id: self.sessionInfo[vin].client_id,
    response_type: 'device_code',
    scope: (self.config[vin] && self.config[vin].scope) || defaultScope,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  }).toString();
  const res = await bmwApiCall(self, vin, bmwApiRoutes.getDeviceCode, '', body);
  if (res.status != 200 || !res.data) {
    log(0, `Error status ${res.status} on BMW API call to obtain device code: ${JSON.stringify(res.body || res.error || '')}`);
    log(0, 'Check that the client ID is correct and that "Request access to CarData API" is enabled for it in the BMW CarData portal.');
    sendError(self, 'BMW login could not be started (' + res.status + ' ' + ((res.body && res.body.error) || res.error || '') + ').<br>Check client ID and CarData API access in the BMW portal.');
    return;
  }
  self.sessionInfo[vin].device_code = res.data.device_code;
  return {data: res.data};
}

function storeTokens(self, vin, data) {
  const s = self.sessionInfo[vin];
  s.access_token = data.access_token;
  if (data.refresh_token) s.refresh_token = data.refresh_token;
  if (data.id_token) s.id_token = data.id_token;
  if (data.gcid) s.gcid = data.gcid;
  s.token_expiry = Date.now() + (data.expires_in || 3600) * 1000;
  s.refresh_expiry = Date.now() + 1209600 * 1000; // BMW: refresh token valid for two weeks
  saveSession(self);
}

async function getFirstToken(self, vin, deviceData) {
  // poll until the user has entered the code on the BMW website, or the code expires
  const intervalSec = Math.max(deviceData.interval || 5, 5);
  const deadline = Date.now() + (deviceData.expires_in || 300) * 1000;
  const body = new URLSearchParams({
    client_id: self.sessionInfo[vin].client_id,
    device_code: self.sessionInfo[vin].device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    code_verifier: self.sessionInfo[vin].code_verifier
  }).toString();
  let wait = intervalSec;
  while (Date.now() < deadline) {
    await sleep(wait * 1000);
    const res = await bmwApiCall(self, vin, bmwApiRoutes.getToken, '', body);
    if (res.status === 200 && res.data && res.data.access_token) {
      storeTokens(self, vin, res.data);
      return {data: res.data};
    }
    const err = res.body && res.body.error;
    log(1, `polling for token: status ${res.status} ${err || ''}`);
    if (err === 'slow_down') wait += 5;
    else if (err && err !== 'authorization_pending') {
      log(0, `authorization failed: ${JSON.stringify(res.body)}`);
      return {error: err};
    }
  }
  log(0, 'device code expired before authorization was completed');
  return {error: 'expired'};
}

async function refreshToken(self, vin) {
  log(1, 'refreshToken() called');
  const body = new URLSearchParams({
    client_id: self.sessionInfo[vin].client_id,
    refresh_token: self.sessionInfo[vin].refresh_token,
    grant_type: 'refresh_token',
  }).toString();
  const res = await bmwApiCall(self, vin, bmwApiRoutes.getToken, '', body);
  if (res.status === 200 && res.data && res.data.access_token) {
    storeTokens(self, vin, res.data);
    return {data: res.data};
  }
  log(0, `refreshing token failed (status ${res.status}), a new authorization will be required`);
  self.sessionInfo[vin].refresh_token = null;
  saveSession(self);
  return {error: 'refresh failed'};
}

async function listContainers(self, vin) {
  const res = await bmwApiCall(self, vin, bmwApiRoutes.listContainers);
  log(1, `Status ${res.status} on BMW API call to list containers`);
  if (res.status === 200 && res.data)
    return {data: res.data};
  log(0, `listing containers failed: ${res.status} ${JSON.stringify(res.body || '')}`);
}

async function createContainer(self, vin) {
  const body = JSON.stringify({
    name: containerName,
    purpose: "data for display on Magic Mirror MMM-BMWCarData module",
    technicalDescriptors: technicalDescriptors
  });
  const res = await bmwApiCall(self, vin, bmwApiRoutes.createContainer, '', body);
  log(1, `Status ${res.status} on BMW API call to create container`);
  if ((res.status === 201 || res.status === 200) && res.data && res.data.containerId) {
    self.sessionInfo[vin].container_id = res.data.containerId;
    containerAttached[vin] = true;
    saveSession(self);
    return {data: res.data};
  }
  log(0, `creating container failed: ${res.status} ${JSON.stringify(res.body || '')}`);
}

async function attachContainer(self, vin, forceDelete) {
  if (containerAttached[vin] && !forceDelete)
    return {data: self.sessionInfo[vin].container_id};
  let res = await listContainers(self, vin);
  if (!res || !res.data)
    return {error: 'listContainers() failed'};
  const containers = res.data.containers || [];
  for (var i = 0; i < containers.length; i++) {
    if ((containers[i].name === containerName) && (containers[i].state !== 'DELETED')) {
      if (forceDelete) {
        log(1, 'existing container found, deleting before re-creating');
        self.sessionInfo[vin].container_id = containers[i].containerId;
        await deleteContainer(self, vin);
      } else {
        log(1, 'existing container found, will use it');
        self.sessionInfo[vin].container_id = containers[i].containerId;
        containerAttached[vin] = true;
        saveSession(self);
        return {data: self.sessionInfo[vin].container_id};
      }
    }
  }
  res = await createContainer(self, vin);
  if (!res || !res.data)
    return {error: 'createContainer() failed'};
  return {data: self.sessionInfo[vin].container_id};
}

async function deleteContainer(self, vin) {
  const res = await bmwApiCall(self, vin, bmwApiRoutes.deleteContainer, '/' + self.sessionInfo[vin].container_id);
  log(1, `Status ${res.status} on BMW API call to delete container`);
  if (res.status === 204 || res.status === 200)
    return {data: 'success'};
}

async function getTelematicData(self, vin) {
  const token = await getAccessToken(self, vin);
  if (!token || !token.data)
    return;
  if (!containerAttached[vin] || !self.sessionInfo[vin].container_id) {
    const c = await attachContainer(self, vin);
    if (!c || !c.data) return;
  }
  const res = await bmwApiCall(self, vin, bmwApiRoutes.readVehicleData, '/' + vin + '/telematicData?containerId=' + self.sessionInfo[vin].container_id);
  log(1, `Status ${res.status} on BMW API call to retrieve telematic data`);
  if (res.status === 200 && res.data)
    return {data: res.data};
  if (res.status === 404 || res.status === 403) {
    // container may have been removed in the portal: re-attach next time
    containerAttached[vin] = false;
  }
  log(0, `retrieving telematic data failed: ${res.status} ${JSON.stringify(res.body || '')}`);
}

async function getVehicleImage(self, vin) {
  const downloadPath = path.join(self.path, 'car-' + vin + '.png');
  if (fs.existsSync(downloadPath)) {
    log(1, 'vehicle image already available');
    return {data: downloadPath};
  }
  const token = await getAccessToken(self, vin);
  const res = await fetchFn(bmwApiRoutes.readVehicleData.url + '/' + vin + '/image', {
    method: 'GET',
    headers: {Accept: '*/*', 'x-version': 'v1', Authorization: 'Bearer ' + token.data}
  });
  if (res.status !== 200) {
    log(0, 'vehicle image not available (status ' + res.status + ')');
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(downloadPath, buf);
  log(1, 'saved vehicle image to ' + downloadPath);
  return {data: downloadPath};
}

async function bmwApiCall(self, vin, route, endpoint, body) {
  const fullRoute = endpoint ? route.url + endpoint : route.url;
  try {
    log(1, 'calling BMW API at ' + fullRoute);
    const headers = Object.assign({}, route.headers);
    if (route.addToken) {
      const token = await getAccessToken(self, vin);
      if (!token || !token.data)
        return {status: 0, data: null, error: 'no access token'};
      headers.Authorization = 'Bearer ' + token.data;
    }
    const res = await fetchFn(fullRoute, {method: route.type, headers: headers, body: body});
    log(1, 'status: ' + res.status);
    const contentType = res.headers.get('content-type') || '';
    let parsed = null;
    if (res.status !== 204) {
      const text = await res.text();
      if (contentType.indexOf('json') !== -1) {
        try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
      } else {
        parsed = text;
      }
    }
    if (res.status >= 300)
      return {status: res.status, data: null, body: parsed};
    return {status: res.status, data: parsed};
  } catch (e) {
    log(0, `BMW API call error: ${e.message}`);
    return {status: 0, data: null, error: e.message};
  }
}
