/**
 * The RaygunClient is responsible for managing the users access to Real User Monitoring and
 * Crash Reporting functionality as well as managing Session specific data.
 */

import {
  BreadcrumbOption,
  CustomData,
  RaygunClientOptions,
  User,
  RealUserMonitoringTimings,
  BeforeSendHandler
} from './Types';
import {clone, getDeviceBasedId, log, warn} from './Utils';
import CrashReporter from './CrashReporter';
import RealUserMonitor from './RealUserMonitor';
import {Animated, NativeModules} from 'react-native';
import event = Animated.event;

const {RaygunNativeBridge} = NativeModules;


/**
 * The RaygunClient is the interface in which this provider publicly shows. The bottom of this page
 * has an 'export' statement which exports the methods defined in the RaygunClient.ts file. Some
 * of the logical components have been separated out from this file and into classes specific to
 * CrashReporting or RealUserMonitoring (CrashReporter.ts and RealUserMonitor.ts respectively).
 */

//#region ----INITIALIZATION------------------------------------------------------------------------

let crashReporter: CrashReporter;
let realUserMonitor: RealUserMonitor;
let options: RaygunClientOptions;
// Raygun Client Global Variables
let initialized: boolean = false;
let currentTags: Set<string> = new Set([]);
let currentUser: User = {
  identifier: `anonymous-${getDeviceBasedId()}`,
  isAnonymous: true
};

/**
 * Initializes the RaygunClient with customized options parse in through an instance of a
 * RaygunClientOptions. Anything unmentioned in the RaygunClientOptions will revert
 * to their default values.
 *
 * @param raygunClientOptions
 */
const init = (raygunClientOptions: RaygunClientOptions) => {
  //Do not reinitialize
  if (initialized) {
    log('Already initialized');
    return false;
  }

  options = {...raygunClientOptions};

  //Cleans options with defaults
  const {
    apiKey = '',
    version = '',
    enableCrashReporting = false,
    disableNativeCrashReporting = false,
    enableRealUserMonitoring = false,
    disableNetworkMonitoring = false,
    customCrashReportingEndpoint = '',
    customRealUserMonitoringEndpoint = '',
    onBeforeSendingCrashReport = null,
    ignoredURLs = []
  } = options;


  //Enable Crash Reporting
  if (enableCrashReporting) {
    crashReporter = new CrashReporter(
      apiKey,
      currentUser,
      currentTags,
      disableNativeCrashReporting,
      customCrashReportingEndpoint || '',
      onBeforeSendingCrashReport as BeforeSendHandler,
      version
    );
    if (!disableNativeCrashReporting) {
      log("Native Bridge Initialized");
      RaygunNativeBridge.initCrashReportingNativeSupport(
          apiKey,
          version,
          customCrashReportingEndpoint
      );
    }
  }

  //Enable Real User Monitoring
  if (enableRealUserMonitoring) {
    realUserMonitor = new RealUserMonitor(
      apiKey,
      currentUser,
      disableNetworkMonitoring,
      ignoredURLs,
      customRealUserMonitoringEndpoint,
      version
    );
    // Add the lifecycle event listeners to the bridge.
    RaygunNativeBridge.initRealUserMonitoringNativeSupport();
  }

  initialized = true;

  return true;
};

//#endregion----------------------------------------------------------------------------------------

//#region ----RAYGUN CLIENT SESSION LOGIC-----------------------------------------------------------

/**
 * Append a tag to the current session tags. These tags will be attached to both Crash Reporting
 * errors AND Real User Monitoring requests.
 * @param tags - The tag(s) to append to the session.
 */
const addTag = (...tags: string[]) => {
  tags.forEach(tag => {
    currentTags.add(tag);
  });

  //Apply tags change to crash reporter
  if (crashReportingAvailable("addTags")) crashReporter.addTags(tags);

  if (!options.disableNativeCrashReporting) {
    RaygunNativeBridge.setTags([...currentTags]);
  }
};

/**
 * Set the user for the current session. This WILL overwrite an existing session user with
 * the new one.
 * @param user - The new name or user object to assign.
 */
const setUser = (user: User | string) => {
  //Discern the type of the user argument and apply it to the user field
  const userObj = Object.assign(
    {firstName: '', fullName: '', email: '', isAnonymous: true},
    typeof user === 'string'
      ? !!user
      ? {identifier: user, isAnonymous: true}
      : {identifier: `anonymous-${getDeviceBasedId()}`, isAnonymous: true}
      : user
  );

  //Update user across the react side
  currentUser = userObj;
  if (crashReportingAvailable('setUser')) crashReporter.setUser(userObj);
  if (realUserMonitoringAvailable('setUser')) realUserMonitor.setUser(userObj);

  //Update user on the
  if (!options.disableNativeCrashReporting) {
    RaygunNativeBridge.setUser(userObj);
  }
};

//#endregion----------------------------------------------------------------------------------------

//#region ----CRASH REPORTING LOGIC-----------------------------------------------------------------

/**
 * Create and store a new Breadcrumb.
 * @param message - A string to describe what this breadcrumb signifies.
 * @param details - Details about the breadcrumb.
 */
const recordBreadcrumb = (message: string, details?: BreadcrumbOption) => {
  if (!crashReportingAvailable('recordBreadcrumb')) return;
  crashReporter.recordBreadcrumb(message, details);
};

/**
 * Allows for an error to be sent to the Crash Reporting error handler along with some customized
 * data. 'params' can be configured in the following ways:
 *    1) data: CustomData, ... tags: string
 *    2) data: CustomData
 *    3) ... tags: string
 *
 * If custom data is being parsed with this method, ensure it is placed first before any tags.
 * Also ensure that the custom data is a CustomData instance, all tags will be strings.
 *
 * @example
 * 1)   RaygunClient.sendError(new Error(), {[Date.now()]: `This is just an example`}, "Foo", "Bar");
 * 2)   RaygunClient.sendError(new Error(), {[Date.now()]: `This is just an example`});
 * 3)   RaygunClient.sendError(new Error(), "Foo", "Bar");
 *
 * @param error - The error.
 * @param params - Custom data or tags alongside the error.
 * @see CustomData
 */
const sendError = async (error: Error, ...params: any) => {
  if (!crashReportingAvailable('sendError')) return;

  const [customData, tags] = params.length == 1 && Array.isArray(params[0]) ? [null, params[0]] : params;

  if (customData) {
    addCustomData(customData as CustomData);
  }
  if (tags && tags.length) {
    addTag(...(tags as string[]));
  }

  await crashReporter.processUnhandledError(error);
};

/**
 * Appends custom data to the current set of custom data.
 * @param customData - The custom data to append
 */
const addCustomData = (customData: CustomData) => {
  if (!crashReportingAvailable('addCustomData')) return;
  crashReporter.addCustomData(customData);
};

/**
 * Apply some transformation lambda to all of the user's custom data.
 * @param updater - The transformation.
 */
const updateCustomData = (updater: (customData: CustomData) => CustomData) => {
  if (!crashReportingAvailable('updateCustomData')) return;
  crashReporter.updateCustomData(updater);
};

/**
 * Let the user change the size of the CrashReporter cache
 * @param size
 */
const setMaxReportsStoredOnDevice = (size: number) => {
  if (!crashReportingAvailable('setCrashReportCacheSize')) return;
  crashReporter.setMaxReportsStoredOnDevice(size);
}

/**
 * Checks if the CrashReporter has been created (during RaygunClient.init) and if the user enabled
 * the CrashReporter during the init.
 */
const crashReportingAvailable = (calledFrom: string) => {
  if (!initialized) {
    warn(
      `Failed: "${calledFrom}" cannot be called before initialising RaygunClient. Please call RaygunClient.init(...) before trying to call RaygunClient.${calledFrom}(...)`
    );
    return false;
  } else if (!(crashReporter && options.enableCrashReporting)) {
    warn(
      `Failed: "${calledFrom}" cannot be called unless Crash Reporting has been enabled, please ensure that you set "enableCrashReporting" to true during RaygunClient.init(...)`
    );
    return false;
  }
  return true;
};

//#endregion----------------------------------------------------------------------------------------

//#region ----REAL USER MONITORING LOGIC------------------------------------------------------------

/**
 * Construct a Real User Monitoring Timing Event and send it to the Real User Monitor to be transmitted.
 * @param eventType - Type of Real User Monitoring event.
 * @param name - Name of this event.
 * @param timeUsedInMs - Length this event took to execute.
 */
const sendRUMTimingEvent = (eventType: RealUserMonitoringTimings, name: string, durationMs: number) => {
  if (!realUserMonitoringAvailable('sendRUMTimingEvent')) return;
  realUserMonitor.sendCustomRUMEvent(eventType, name, durationMs);
};

/**
 * Checks if the RealUserMonitor has been created (during RaygunClient.init) and if the user enabled
 * the RealUserMonitor during the init.
 */
const realUserMonitoringAvailable = (calledFrom: string) => {
  if (!initialized) {
    warn(
      `Failed: "${calledFrom}" cannot be called before initialising RaygunClient. Please call RaygunClient.init(...) before trying to call RaygunClient.${calledFrom}(...)`
    );
    return false;
  }
  if (!(realUserMonitor && options.enableRealUserMonitoring)) {
    warn(
      `Failed: "${calledFrom}" cannot be called unless Real User Monitoring has been enabled, please ensure that you set "enableRealUserMonitoring" to true during RaygunClient.init(...)`
    );
    return false;
  }
  return true;
};

//#endregion----------------------------------------------------------------------------------------


export {
  init,
  addTag,
  setUser,
  recordBreadcrumb,
  addCustomData,
  sendError,
  setMaxReportsStoredOnDevice,
  updateCustomData,
  sendRUMTimingEvent
};
