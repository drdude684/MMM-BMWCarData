const NodeHelper = require("node_helper");
const Log = require("logger");

const fs = require('fs');
const bmwAPIPaths = {
  carDataBase: 'https://api-cardata.bmwgroup.com',
  deviceCodeFlowBase: 'https://customer.bmwgroup.com/gcdm/oauth',
};

var sessionInfoFile='./bmw_session_info.json';

module.exports = NodeHelper.create({
  start: async function () {
    log("Starting node_helper for module: " + this.name);
    sessionInfoFile=this.path+'/'+'bmw_token_info.json';
    this.sessionInfo = {
      access_token: null,
      refresh_token: null,
      id_token: null,
      token_expiry: null,
      refresh_expiry: null,
      device_code: null,   
      container_id: null,   
    };
    this.config = {};
    this.bmwInfo = {};
    
    log(`attempting to load token info from file ${sessionInfoFile}`);
    if (fs.existsSync(sessionInfoFile))
      this.sessionInfo=JSON.parse(fs.readFileSync(sessionInfoFile,'utf8'));
      
    log('initial content of sessionInfo structure:');
    log(JSON.stringify(this.sessionInfo));

    //res=await getAccessToken(this);
    //log('obtained token: '+JSON.stringify(res.data));
    
    //cExists=await containerExists(this);
    //if (!cExists) {
      //res=await createContainer(this);
    //}
    
    //res=await getTelematicData(this);
    //log('requested first telematic data, result:')
  
    //log(JSON.stringify(res.data));
    
  },
  
  socketNotificationReceived: async function (notification, payload) {
    var self = this;
    var vin = payload.vin;

    if (notification == "MMM-BMWCARDATA-CONFIG") {
      self.config[vin] = payload;
      self.bmwInfo[vin] = null;
    } else if (notification == "MMM-BMWCARDATA-GET") {
      log('Updating data for ' + vin);
      const config = self.config[vin];

      //while (self.resourceLocked) {
        //console.log('MMM-BMWCarData: Resource is locked, waiting...');
        //const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        //await delay(10000);
      //}
      //self.resourceLocked = true;
      //const pythonProcess = spawn('python3',["modules/MMM-MyBMW/getMyBMWData.py", config.email, config.password, config.vin, config.region, config.hCaptchaToken, config.authStorePath]);

      //pythonProcess.stdout.on('data', (data) => {
        //self.bmwInfo[vin] = JSON.parse(data);
        //self.sendResponse(payload);
        //self.resourceLocked = false;
      //});

      //pythonProcess.stderr.on('data', (data) => {
        //console.error(`bimmer_connected error: ${data}`);
        //self.resourceLocked = false;
      //});

      //setTimeout(function(){self.resourceLocked = false;}, 20000);
    }
  }
    
})

function log(message) {
  Log.log('MMM-BMWCarData helper: '+message);
}

async function getAccessToken(self){
  log('getAccessToken() called');
  
  currentTime=new Date(Date.now()).getTime()
  log(`Current time: ${currentTime}`)

  if(!self.sessionInfo.token_expiry||(self.sessionInfo.refresh_expiry<currentTime)) {
    log('existing refresh token has expired or is not available, interactive user authentication on BMW portal will be required');

    res=await getDeviceCode(self);
    if(!res.data)
      return {error: 'could not obtain device code'};
      
    fs.writeFile(sessionInfoFile,JSON.stringify(self.sessionInfo),err=>{if(err){log(err)}});
    log(`Please visit ${res.data.verification_uri} within the next ${res.data.expires_in} seconds, log in (if required), and enter the following code:\n${res.data.user_code}`)

    res=await getFirstToken(self,0);
    if(!res.data)
      return {error: 'could not obtain first token'};
      
    return {data:self.sessionInfo.access_token};
  }
  if(!self.sessionInfo.token_expiry||(self.sessionInfo.token_expiry<currentTime)) {
    log('existing token has expired');
    res=await refreshToken(self);
    if(!res.data)
      return {error: 'could not refresh token'};
      
    return {data:self.sessionInfo.access_token};
  }
  
  log('token requested, but no renewals required, will provide current token')
  return {data:self.sessionInfo.access_token};
}

async function getDeviceCode(self){
  log('getDeviceCode() called');
  bodydata={  
    client_id: self.bmwInfo[0].clientId,
    response_type: 'device_code',
    scope: 'authenticate_user openid cardata:api:read cardata:streaming:read',
    code_challenge: '6xSQkAzH8oEmFMieIfFjAlAsYMS23uhOCXg70Gf13p8',
    code_challenge_method: 'S256'
  }
  bodydata_string=new URLSearchParams(Object.entries(bodydata)).toString();
  res=await bmwDeviceCodeFlowApiCall('device/code',bodydata_string);
  if (res.status!=200) {
    log(`Error status ${res.status} on BMW API call to obtain device code`);
    return;
  }  
  try {
    log(JSON.stringify(res.data));
    self.sessionInfo.device_code=res.data.device_code;
    return {data: res.data}
  }
  catch(e) {
    log(`Error in getDeviceCode: ${e.message}`)
    return {error: `${e.message}`};
  }    
}

async function getFirstToken(self,iteration){
  log(`getFirstToken() called, iteration# ${iteration}`);
  
  // we assume the user is aware that he should log in to the BMW website as instucted in the previous step
  // and we are now going to poll for a while until user has successfully logged in
  
  const maxIterations = 9;
  const pollingInterval = 30;
  
  bodydata={  
    client_id: self.bmwInfo[0].clientId,
    device_code: self.sessionInfo.device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    code_verifier: 'Lc-kVofs3uj2Aj5Yrpd8X8Sa0N6tGmp4VIjflKSbFSQ'
  }
  bodydata_string=new URLSearchParams(Object.entries(bodydata)).toString();
  res=await bmwDeviceCodeFlowApiCall('token',bodydata_string);
  log(`Status ${res.status} on BMW API call to obtain first token`);
  if(res.status==200){
    try{      
      log(JSON.stringify(res.data));
      self.sessionInfo.access_token=res.data.access_token;
      self.sessionInfo.refresh_token=res.data.refresh_token;
      self.sessionInfo.id_token=res.data.id_token;
      exptime=new Date(Date.now()).getTime()+res.data.expires_in*1000;
      self.sessionInfo.token_expiry=exptime;
      exptime=new Date(Date.now()).getTime()+1200000*1000;// hard coded limit; BMW website establishes 1.209.600 seconds (two weeks)
      self.sessionInfo.refresh_expiry=exptime;
      fs.writeFile(sessionInfoFile,JSON.stringify(self.sessionInfo),err=>{if(err){log(err)}});          
      return {data: res.data};
    }    
    catch(e) {
      log(`Exception in getFirstToken: ${e.message}`)
      return {error: `${e.message}`};
    }
  }
  else{
    log('Non-success statusword while polling for first token');
    if(iteration>maxIterations) {
      log('Too many iterations, giving up');
      return {error: 'Too many iterations while polling for first token'};
    }
    log(`Will retry in ${pollingInterval} seconds`);
    await new Promise((resolve) => {setTimeout(resolve, 30*1000)});
    return await getFirstToken(self,iteration+1);
  }
}

async function refreshToken(self,iteration){
  log('refreshToken() called');  
  
  bodydata={  
    client_id: self.bmwInfo[0].clientId,
    refresh_token: self.sessionInfo.refresh_token,
    grant_type: 'refresh_token',
  }
  bodydata_string=new URLSearchParams(Object.entries(bodydata)).toString();
  res=await bmwDeviceCodeFlowApiCall('token',bodydata_string);
  log(`Status ${res.status} on BMW API call to refresh token`);
  if(res.status==200){
    try{      
      log(JSON.stringify(res.data));
      self.sessionInfo.access_token=res.data.access_token;
      self.sessionInfo.refresh_token=res.data.refresh_token;
      self.sessionInfo.id_token=res.data.id_token;
      exptime=new Date(Date.now()).getTime()+res.data.expires_in*1000;
      self.sessionInfo.token_expiry=exptime;
      fs.writeFile(sessionInfoFile,JSON.stringify(self.sessionInfo),err=>{if(err){log(err)}});          
      return {data: res.data};
    }    
    catch(e) {
      log(`Exception in refreshToken: ${e.message}`)
      return {error: `${e.message}`};
    }
  }
  else{
    log('Non-success statusword while refreshing token');
    return {error:'Non-success statusword while refreshing token'};
  }
}

async function containerExists(self){
  log('containerExists() called');
  return true; //TBD
}

async function createContainer(self){
  log('createContainer() called');  
  
  var bodydata={  
    name: "Basic data",
    purpose: "data for display on Magic Mirror",
    technicalDescriptors: [
      "vehicle.cabin.infotainment.navigation.remainingRange",
      "vehicle.drivetrain.fuelSystem.remainingFuel",
      "vehicle.drivetrain.fuelSystem.level",
      "vehicle.vehicle.travelledDistance",
      "vehicle.status.serviceDistance.next",
      "vehicle.cabin.door.lock.status",
      "vehicle.body.lights.isRunningOn",
      "vehicle.cabin.infotainment.navigation.currentLocation.latitude",
      "vehicle.cabin.infotainment.navigation.currentLocation.longitude"
      ]
  }
  bodydata_string=JSON.stringify(bodydata);
  log('body data:');
  log(bodydata_string);
  res=await bmwCarDataApiCallPost(self,'customers/containers',bodydata_string);
  log(`Status ${res.status} on BMW API call to create container`);
  if(res.status==201){
    try{      
      log(JSON.stringify(res.data));
      self.sessionInfo.container_id=res.data.containerId;
      fs.writeFile(sessionInfoFile,JSON.stringify(self.sessionInfo),err=>{if(err){log(err)}});          
      return {data: res.data};
    }    
    catch(e) {
      log(`Exception while creating Container: ${e.message}`)
      return {error: `${e.message}`};
    }
  }  
}

async function getTelematicData(self){
  log('getTelematicData() called');  
  
  if(true) {  // dummy response so as not to overload BMW API server
    res=JSON.parse('{"telematicData":{"vehicle.drivetrain.fuelSystem.remainingFuel":{"timestamp":"2025-12-20T16:54:10.000Z","unit":"l","value":"21"},"vehicle.cabin.infotainment.navigation.currentLocation.latitude":{"timestamp":"2025-12-20T16:54:10.000Z","unit":"degrees","value":"54.0231"},"vehicle.vehicle.travelledDistance":{"timestamp":"2025-12-20T16:54:10.000Z","unit":"km","value":"38402"},"vehicle.drivetrain.fuelSystem.level":{"timestamp":"2025-12-20T16:54:10.000Z","unit":"%","value":"48"},"vehicle.body.lights.isRunningOn":{"timestamp":null,"unit":null,"value":null},"vehicle.cabin.infotainment.navigation.currentLocation.longitude":{"timestamp":"2025-12-20T16:54:10.000Z","unit":"degrees","value":"7.3981"},"vehicle.status.serviceDistance.next":{"timestamp":null,"unit":null,"value":null},"vehicle.cabin.door.lock.status":{"timestamp":"2025-12-20T16:54:10.000Z","unit":null,"value":"SECURED"},"vehicle.cabin.infotainment.navigation.remainingRange":{"timestamp":null,"unit":null,"value":null}}}');
    return {data:res};
  }
  
  res=await bmwCarDataApiCallGet(self,'customers/vehicles/'+self.bmwInfo[0].VIN+'/telematicData?containerId='+self.sessionInfo.container_id);
  log(`Status ${res.status} on BMW API call to retrieve Telematic data`);
  if(res.status==200){
    try{      
      log('response: '+JSON.stringify(res.data));
      return {data: res.data};
    }    
    catch(e) {
      log(`Exception while creating Container: ${e.message}`)
      return {error: `${e.message}`};
    }
  }  
}

async function bmwDeviceCodeFlowApiCall(endpoint,body){
  route=bmwAPIPaths.deviceCodeFlowBase+'/'+endpoint;
  try {
    log('calling BMW API at '+route);
    log('body: '+body);
    var res = await fetch(route, {
      method: 'POST', 
      headers: {Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'},      
      body: body
      });
    log('status: '+res.status);
    if (res.status >= 300)
      return {status:res.status, data: null};
    let content_type=res.headers.get('content-type')
    if (content_type == null) 
      return {status:res.status, data:null}
    if (content_type.includes('application/json'))
      return {status:res.status, data: await res.json()}
    else
      return {status:res.status, data: await res.text()}
    log(`BMW API status error: ${res.status}`)
    return {error: `BMW: ${res.status}`};
  } catch(e) {
    log(`BMW API call error: ${e.message}`)
    return {error: `BMW: ${e.message}`};
  }
}

async function bmwCarDataApiCallPost(self,endpoint,body){
  route=bmwAPIPaths.carDataBase+'/'+endpoint;
  try {
    log('calling BMW API at '+route);
    log('body: '+body);
    var res = await fetch(route, {
      method: 'POST', 
      headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'x-version':'v1','Authorization':'Bearer '+self.sessionInfo.access_token},      
      body: body
      });
    log('status: '+res.status);
    if (res.status >= 300)
      return {status:res.status, data: null};
    let content_type=res.headers.get('content-type')
    if (content_type == null) 
      return {status:res.status, data:null}
    if (content_type.includes('application/json'))
      return {status:res.status, data: await res.json()}
    else
      return {status:res.status, data: await res.text()}
    log(`BMW API status error: ${res.status}`)
    return {error: `BMW: ${res.status}`};
  } catch(e) {
    log(`BMW API call error: ${e.message}`)
    return {error: `BMW: ${e.message}`};
  }
}

async function bmwCarDataApiCallGet(self,endpoint){
  route=bmwAPIPaths.carDataBase+'/'+endpoint;
  try {
    log('calling BMW API at '+route);
    var res = await fetch(route, {
      method: 'GET', 
      headers: {Accept: 'application/json', 'x-version':'v1','Authorization':'Bearer '+self.sessionInfo.access_token},      
      });
    log('status: '+res.status);
    if (res.status >= 300)
      return {status:res.status, data: null};
    let content_type=res.headers.get('content-type')
    if (content_type == null) 
      return {status:res.status, data:null}
    if (content_type.includes('application/json'))
      return {status:res.status, data: await res.json()}
    else
      return {status:res.status, data: await res.text()}
    log(`BMW API status error: ${res.status}`)
    return {error: `BMW: ${res.status}`};
  } catch(e) {
    log(`BMW API call error: ${e.message}`)
    return {error: `BMW: ${e.message}`};
  }
}



// original MMM-MyBMW node_helper below
//var NodeHelper = require("node_helper");
//const spawn = require("child_process").spawn;

//module.exports = NodeHelper.create({

  //start: function () {
    //console.log("Starting node_helper for module: " + this.name);
    //this.bmwInfo = {};
    //this.config = {};
    //this.resourceLocked = false;
  //},

  //socketNotificationReceived: async function (notification, payload) {

    //var self = this;
    //var vin = payload.vin;

    //if (notification == "MMM-BMWCARDATA-CONFIG") {
      //self.config[vin] = payload;
      //self.bmwInfo[vin] = null;
    //} else if (notification == "MMM-BMWCARDATA-GET") {
      //console.log('MMM-BMWCarData: Updating data for ' + vin);
      //const config = self.config[vin];

      //while (self.resourceLocked) {
        //console.log('MMM-BMWCarData: Resource is locked, waiting...');
        //const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        //await delay(10000);
      //}
      //self.resourceLocked = true;
      //const pythonProcess = spawn('python3',["modules/MMM-MyBMW/getMyBMWData.py", config.email, config.password, config.vin, config.region, config.hCaptchaToken, config.authStorePath]);

      //pythonProcess.stdout.on('data', (data) => {
        //self.bmwInfo[vin] = JSON.parse(data);
        //self.sendResponse(payload);
        //self.resourceLocked = false;
      //});

      //pythonProcess.stderr.on('data', (data) => {
        //console.error(`bimmer_connected error: ${data}`);
        //self.resourceLocked = false;
      //});

      //setTimeout(function(){self.resourceLocked = false;}, 20000);
    //}
  //},

  //sendResponse: function (payload) {
    //this.sendSocketNotification("MMM-BMWCARDATA-RESPONSE" + payload.instanceId, this.bmwInfo[payload.vin]);
  //},

//});
