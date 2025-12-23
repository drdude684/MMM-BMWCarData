const NodeHelper = require("node_helper");
const Log = require("logger");

const fs = require('fs');

const bmwApiRoutes = {
  getDeviceCode: {type: 'POST', url: 'https://customer.bmwgroup.com/gcdm/oauth/device/code', headers: {Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'}, addToken:false},
  getToken: {type: 'POST', url: 'https://customer.bmwgroup.com/gcdm/oauth/token',headers: {Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'}, addToken:false},
  createContainer: {type: 'POST', url: 'https://api-cardata.bmwgroup.com/customers/containers',headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'x-version':'v1'}, addToken:true},
  readTelematicData: {type: 'GET', url: 'https://api-cardata.bmwgroup.com/customers/vehicles',headers: {Accept: 'application/json', 'x-version':'v1'}, addToken:true},
}

var sessionInfoFile=null;

module.exports = NodeHelper.create({
  start: async function () {
    log("Starting node_helper for module: " + this.name);    
    this.sessionInfo = {};
    this.config = {};
    this.bmwInfo = {};
    
    sessionInfoFile=this.path+'/bmw_session_info.json';

    log(`attempting to load session info from file ${sessionInfoFile}`);
    if (fs.existsSync(sessionInfoFile))
      this.sessionInfo=JSON.parse(fs.readFileSync(sessionInfoFile,'utf8'));
      
    log('initial content of sessionInfo structure:');
    log(JSON.stringify(this.sessionInfo));
    
  },
  
  socketNotificationReceived: async function (notification, payload) {
    var self = this;
    var vin = payload.vin;

    if (notification == "MMM-BMWCARDATA-CONFIG") {
      log('config received from module');
      self.config[vin] = payload;
      self.bmwInfo[vin] = {client_id:payload.clientId,VIN:payload.vin};
      log(JSON.stringify(self.config));
      log(JSON.stringify(self.bmwInfo));
    } else if (notification == "MMM-BMWCARDATA-GET") {
      log('Updating data for ' + vin);
      const config = self.config[vin];
        
      res=await getTelematicData(this,vin);
      log('requested telematic data, result:')

      if(res.data) {
        log(JSON.stringify(res.data));
        locked=((res.data.telematicData["vehicle.cabin.door.lock.status"].value==='SECURED')||(res.data.telematicData["vehicle.cabin.door.lock.status"].value==='LOCKED'));
        this.bmwInfo[vin]={
          mileage:res.data.telematicData["vehicle.vehicle.travelledDistance"].value,
          fuelRange:res.data.telematicData["vehicle.drivetrain.lastRemainingRange"].value,
          doorLock:locked,
        };
        
        log('retrieved vehicle data, now sending it on');
        log(JSON.stringify(this.bmwInfo));
        
        self.sendResponse(payload);
      }
      else
        log('<none>, did not send it to module');
    }
  },
  sendResponse: function (payload) {
    this.sendSocketNotification("MMM-BMWCARDATA-RESPONSE" + payload.instanceId, this.bmwInfo[payload.vin]);
  },

    
})

function log(message) {
  Log.log('MMM-BMWCarData helper: '+message);
}

function sendError(self,error) {
  self.sendSocketNotification("MMM-BMWCARDATA-ERROR",error);
}

async function getAccessToken(self,vin){
  log('getAccessToken() called');
  
  currentTime=new Date(Date.now()).getTime()
  log(`Current time: ${currentTime}`)

  if(!self.sessionInfo[vin]||!self.sessionInfo[vin].token_expiry||(self.sessionInfo[vin].refresh_expiry<currentTime)) {
    log('existing refresh token has expired or is not available, interactive user authentication on BMW portal will be required');

    res=await getDeviceCode(self,vin);
    if(!res.data)
      return {error: 'could not obtain device code'};
      
    fs.writeFile(sessionInfoFile,JSON.stringify(self.sessionInfo),err=>{if(err){log(err)}});
    log(`Please visit ${res.data.verification_uri} within the next ${res.data.expires_in} seconds, log in (if required), and enter the following code:\n${res.data.user_code}`)
    sendError(self,`Authorization required. Visit <br>${res.data.verification_uri}<br> within ${res.data.expires_in} seconds<br>Code: ${res.data.user_code}`)
    
    log('start polling for user to provide authorization');
    res=await getFirstToken(self,vin,0);
    if(!res.data)
      return {error: 'could not obtain first token'};
      
    log('start polling for user to provide authorization');
    res=await createContainer(self,vin);
    if(!res.data)
      return {error: 'could not create Container'};
     
    sendError(self,'');//all is well, time to clear the instruction to provide authorization
      
    log('initial token flow successful, providing token');
    return {data:self.sessionInfo[vin].access_token};
  }
  if(!self.sessionInfo[vin].token_expiry||(self.sessionInfo[vin].token_expiry<currentTime)) {
    log('existing token has expired');
    res=await refreshToken(self,vin);
    if(!res.data)
      return {error: 'could not refresh token'};
      
    log('refresh token flow successful, providing token');
    return {data:self.sessionInfo[vin].access_token};
  }
  
  log('token requested, but no renewals required, will provide current token')
  return {data:self.sessionInfo[vin].access_token};
}

async function getDeviceCode(self,vin){
  log('getDeviceCode() called');
  bodydata={  
    client_id: self.bmwInfo[vin].client_id,
    response_type: 'device_code',
    scope: 'authenticate_user openid cardata:api:read cardata:streaming:read',
    code_challenge: '6xSQkAzH8oEmFMieIfFjAlAsYMS23uhOCXg70Gf13p8',
    code_challenge_method: 'S256'
  }
  bodydata_string=new URLSearchParams(Object.entries(bodydata)).toString();
  res=await bmwApiCall(self,vin,bmwApiRoutes.getDeviceCode,'',bodydata_string);
  if (res.status!=200) {
    log(`Error status ${res.status} on BMW API call to obtain device code`);
    return;
  }  
  try {
    log(JSON.stringify(res.data));
    if(!self.sessionInfo[vin])
      self.sessionInfo[vin]={};
    self.sessionInfo[vin].device_code=res.data.device_code;
    self.sessionInfo[vin].c=res.data.device_code;
    return {data: res.data}
  }
  catch(e) {
    log(`Error in getDeviceCode: ${e.message}`)
    return {error: `${e.message}`};
  }    
}

async function getFirstToken(self,vin,iteration){
  log(`getFirstToken() called, iteration# ${iteration}`);
  
  // we assume the user is aware that he should log in to the BMW website as instucted in the previous step
  // and we are now going to poll for a while until user has successfully logged in
  
  const maxIterations = 9;
  const pollingInterval = 30;
  
  bodydata={  
    client_id: self.bmwInfo[vin].client_id,
    device_code: self.sessionInfo[vin].device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    code_verifier: 'Lc-kVofs3uj2Aj5Yrpd8X8Sa0N6tGmp4VIjflKSbFSQ'
  }
  bodydata_string=new URLSearchParams(Object.entries(bodydata)).toString();
  res=await bmwApiCall(self,vin,bmwApiRoutes.getToken,'',bodydata_string);
  log(`Status ${res.status} on BMW API call to obtain first token`);
  if(res.status==200){
    try{      
      log(JSON.stringify(res.data));
      self.sessionInfo[vin].access_token=res.data.access_token;
      self.sessionInfo[vin].refresh_token=res.data.refresh_token;
      self.sessionInfo[vin].id_token=res.data.id_token;
      exptime=new Date(Date.now()).getTime()+res.data.expires_in*1000;
      self.sessionInfo[vin].token_expiry=exptime;
      exptime=new Date(Date.now()).getTime()+1200000*1000;// hard coded limit; BMW website establishes 1.209.600 seconds (two weeks)
      self.sessionInfo[vin].refresh_expiry=exptime;
      fs.writeFile(sessionInfoFile,JSON.stringify(self.sessionInfo),err=>{if(err){log(err)}});          
      self.bmwInfo[vin].error=null;
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
    res= await getFirstToken(self,vin,iteration+1);
    return res;
  }
}

async function refreshToken(self,vin,iteration){
  log('refreshToken() called');  
  
  bodydata={  
    client_id: self.bmwInfo[vin].client_id,
    refresh_token: self.sessionInfo[vin].refresh_token,
    grant_type: 'refresh_token',
  }
  bodydata_string=new URLSearchParams(Object.entries(bodydata)).toString();
  res=await bmwApiCall(self,vin,bmwApiRoutes.getToken,'',bodydata_string);
  log(`Status ${res.status} on BMW API call to refresh token`);
  if(res.status==200){
    try{      
      log(JSON.stringify(res.data));
      self.sessionInfo[vin].access_token=res.data.access_token;
      self.sessionInfo[vin].refresh_token=res.data.refresh_token;
      self.sessionInfo[vin].id_token=res.data.id_token;
      exptime=new Date(Date.now()).getTime()+res.data.expires_in*1000;
      self.sessionInfo[vin].token_expiry=exptime;
      exptime=new Date(Date.now()).getTime()+1200000*1000;// hard coded limit; BMW website establishes 1.209.600 seconds (two weeks)
      self.sessionInfo[vin].refresh_expiry=exptime;
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
  return false; //TBD
}

async function createContainer(self,vin){
  log('createContainer() called');  
  
  var bodydata={  
    name: "MM_data",
    purpose: "data for display on Magic Mirror MMM-BMWCardData module",
    technicalDescriptors: [
      "vehicle.cabin.infotainment.navigation.remainingRange", // may not work, to be investigated
      "vehicle.drivetrain.fuelSystem.remainingFuel",
      "vehicle.drivetrain.fuelSystem.level",
      "vehicle.vehicle.travelledDistance",
      "vehicle.cabin.door.lock.status",
      "vehicle.body.lights.isRunningOn", // may not work, to be investigated
      "vehicle.drivetrain.lastRemainingRange"
      ]
  }
  bodydata_string=JSON.stringify(bodydata);
  log('body data:');
  log(bodydata_string);
  res=await bmwApiCall(self,vin,bmwApiRoutes.createContainer,'',bodydata_string);
  log(`Status ${res.status} on BMW API call to create container`);
  if(res.status==201){
    try{      
      log(JSON.stringify(res.data));
      self.sessionInfo[vin].container_id=res.data.containerId;
      fs.writeFile(sessionInfoFile,JSON.stringify(self.sessionInfo),err=>{if(err){log(err)}});          
      return {data: res.data};
    }    
    catch(e) {
      log(`Exception while creating Container: ${e.message}`)
      return {error: `${e.message}`};
    }
  }  
}

async function getTelematicData(self,vin){
  log('getTelematicData() called');  
  
  //if(true) {  // dummy response so as not to overload BMW API server while debugging
    //res=JSON.parse('{"telematicData":{"vehicle.drivetrain.fuelSystem.remainingFuel":{"timestamp":"2025-12-20T16:54:10.000Z","unit":"l","value":"21"},"vehicle.vehicle.travelledDistance":{"timestamp":"2025-12-20T16:54:10.000Z","unit":"km","value":"38402"},"vehicle.drivetrain.fuelSystem.level":{"timestamp":"2025-12-20T16:54:10.000Z","unit":"%","value":"48"},"vehicle.body.lights.isRunningOn":{"timestamp":null,"unit":null,"value":null},"vehicle.drivetrain.lastRemainingRange":{"timestamp":"2025-12-20T16:54:10.000Z","unit":"km","value":"279"},"vehicle.cabin.door.lock.status":{"timestamp":"2025-12-20T16:54:10.000Z","unit":null,"value":"SECURED"},"vehicle.cabin.infotainment.navigation.remainingRange":{"timestamp":null,"unit":null,"value":null}}}');
    //return {data:res};
  //}
  
  res=await getAccessToken(self,vin); // to ensure all has been properly initiated and self.bmwInfo[vin] etc. will exist in the next call
  
  res=await bmwApiCall(self,vin,bmwApiRoutes.readTelematicData,'/'+self.bmwInfo[vin].VIN+'/telematicData?containerId='+self.sessionInfo[vin].container_id);
  log(`Status ${res.status} on BMW API call to retrieve Telematic data`);
  if(res.status==200){
    try{      
      return {data: res.data};
    }    
    catch(e) {
      log(`Exception while processing telematic data: ${e.message}`)
      return {error: `${e.message}`};
    }
  }  
}

async function bmwApiCall(self,vin,route,endpoint,body){
  fullroute=route.url+endpoint;
  try {
    log('calling BMW API at '+fullroute);
    if(body)
      log('body: '+body);
    fullHeaders=route.headers;
    if(route.addToken) {
      token=await getAccessToken(self,vin);
      fullHeaders.Authorization='Bearer '+token.data;
    }
    log('headers: '+await JSON.stringify(fullHeaders));    
    var res = await fetch(fullroute, {
      method: route.type, 
      headers: fullHeaders,      
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

