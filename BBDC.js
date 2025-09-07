// ==UserScript==
// @name         BBDC practical lesson booking monitor
// @version      1.2
// @description  Checks BBDC lesson availability and notifies when slots are available.
// @author       Xinyuan
// @match        https://booking.bbdc.sg/*
// @connect      api.telegram.org
// @require      https://unpkg.com/tesseract.js@6.0.1/dist/tesseract.min.js
// ==/UserScript==

const BOT_TOKEN = '';
const CHAT_ID = ''; // Find this in https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates

const userId = ''; // Your BBDC user ID
const userPass = ''; // Your BBDC password

const debugging = false; // Debugging class 3 availability checks, set to true to enable

// === CONFIGURATION ===
const DATE_RANGE = ["2025-07-14", "2025-07-31"];    // Set your desired date range here
const MIN_SESSION = 1;                              // Earliest session to consider (1-8, 1 for all, 2 for morning after 09:20 etc.)
const MIN_WEEKDAY_SESSION = 1;                      // Earliest session to consider for weekdays (1-8, 1 for all, 6 for evenings after 19:20 etc.)

const INTERVAL_MINUTES_MIN = 1.5;                   // Minimum refresh interval in minutes
const INTERVAL_MINUTES_MAX = 3;                     // Maximum refresh interval in minutes
const ONLY_SHOW_NEW = true;                         // Only show new available slots since last check

// BBDC Booking Details

const check2B = true;                        // Check for 2B practical lessons
const check3C = false;                       // Check for 3C practical lessons

// To find these values, inspect the network requests in your browser's developer tools, look for request listPracSlotReleased -> Payload
// Leave these empty to automatically select the highest bookable subject
let stageSubNo = '';                              // Subject code to monitor
let stageSubDesc = '';                            // Description for the subject
let subVehicleType = '';                          // Vehicle type, e.g., 'Circuit' for circuit lessons
// const stageSubNo = '3.02';
// const stageSubDesc = 'Subject 3.2';
// const subVehicleType = 'Circuit';

let tryBook = false; // Try to book when a slot is available

const sleep_time = ["0038","1037"]

// Global vars, do not touch
let logged_in = true;
let lastCheckTime = null; // Track last check time
let initializeID;
let availabilityID;
let lastTelegramMessageRes = null;
let clickedLogout = false; // Track if logout button was clicked
const userInfo = {};
const worker = await Tesseract.createWorker('eng');
let disabled = false;
let trySolve = true;

let login_tries = 3;
let check_tries = 3;

let refreshTimeoutId = null;

(function() {
    'use strict';

    let waitForVue;
    waitForVue ??= setInterval(() => {
        const app = document.querySelector('#app');
        if (app?.__vue__?.$store) {
            clearInterval(waitForVue);
            waitForVue = null; // Clear the interval ID

            const store = app.__vue__.$store;

            // Deal with auto logout
            console.tlog('[Monitor] Patching auto logout...');
            store.subscribeAction({
                before: (action, state) => {
                    console.tlog("Action: ", action.type, action.payload)
                    if (action.type === 'user/logOut' && !clickedLogout) {
                        console.tlog('[Monitor] User auto logged out, saving current state...');
                        userInfo.cookie = getAuthToken();
                        userInfo.userName = state.user.userName;
                        userInfo.courseType = state.user.courseType;
                        userInfo.authToken = state.user.authToken;
                    }
                },
                after: (action, state) => {
                    if (action.type === 'user/logOut' && !clickedLogout) {
                        console.tlog('[Monitor] User auto logged out, restoring previous state...');
                        store.commit("user/set_userName", userInfo.userName);
                        store.commit("user/set_courseType", userInfo.courseType);
                        store.commit("user/set_authToken", userInfo.authToken);
                        store.commit("user/set_global_canDoBooking", true);
                        document.cookie = `bbdc-token=${encodeURIComponent(userInfo.cookie)}`;
                        app.__vue__.$router.push("/"); // Wait for auto redirect
                    } else if (action.type === 'user/logOut' && clickedLogout) {
                        console.tlog('[Monitor] User clicked logout button, not restoring previous state');
                        clickedLogout = false; // Reset the flag after handling logout
                        disabled = true; // Disable further actions
                    }
                }
            })

            // store.subscribe((mutation, state) => {
            //     console.tlog("Mutation: ", mutation.type, mutation.payload)
            // })

            addLogoutButtonListener(); // Add listener to logout button

            // First run
            console.tlog('[Monitor] Initializing BBDC Booking Monitor...');
            initializeID ??= setInterval(initializeWhenReady, 1000);
        }
    }, 500);
})();

function timestamp() {
    return `[${new Date().toLocaleTimeString()}]`;
}
console.tlog = function(...args) {
    console.log(timestamp(), ...args);
};
console.terror = function(...args) {
    console.error(timestamp(), ...args);
};

function addLogoutButtonListener() {
    const logoutButton = document.getElementsByClassName("btn")[0];
    if (logoutButton) {
        console.tlog('[Monitor] Logout button found:', logoutButton);
        logoutButton.addEventListener("click", function(){
            clickedLogout = true;
        }, true);
        return true; // Successfully added listener
    }
    console.terror('[Monitor] Logout button not found, cannot add listener');
    return false; // Logout button not found
}

async function initializeWhenReady() {
    if (disabled) {
        clearInterval(initializeID);
        return;
    }
    if (isLoggedIn()) {
        if (!logged_in) {
            sendTelegramNotification('Logged in successfully');
            console.tlog('[Login] Logged in successfully');
            logged_in = true;
            addLogoutButtonListener(); // Ensure logout button listener is added
        }
        if (!initCourseSelection()) {
            return;
        }
        clearInterval(initializeID);
        initializeID = null;
        console.tlog('[Monitor] Starting monitoring...');
        checkAvailability();
    } else {
        if (logged_in) {
            console.tlog('[Login] Logged out, reinitializing...');
        }
        logged_in = false;
        if (!userId || !userPass) {
            return;
        } else {
            console.tlog('[Login] Attempting to log in...');
            clearInterval(initializeID);
            initializeID = null;
            let login_result;
            while (login_tries > 0){
                try {
                    login_result = await login(trySolve);
                    break;
                } catch (error) {
                    console.terror(error);
                    console.tlog(`[Login] Error in login, ${login_tries} tries left`);
                    login_tries -= 1;
                    if (login_tries <= 0) {
                        await showNotification("Error in login", "Error in login exceeded max tries. Please check manually.")
                        throw error;
                    }
                }
            }
            if (login_result) {
                console.tlog('[Login] Login done');
                trySolve = true;
                initializeID ??= setInterval(initializeWhenReady, 1000);
            } else {
                sendTelegramNotification('Login failed, manual intervention required');
            }
        }
    }
}

function secondsUntilEnd(check_time) {
    const [start, end] = check_time;

    // Current time
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const current = hh + mm;

    // Helper to convert "HHMM" to today's Date object
    function toDate(hhmm) {
        const h = parseInt(hhmm.slice(0, 2), 10);
        const m = parseInt(hhmm.slice(2), 10);
        const d = new Date(now);
        d.setHours(h, m, 0, 0);
        return d;
    }

    const startTime = toDate(start);
    let endTime = toDate(end);

    // Handle wrap-around (e.g., 2200–0200)
    if (end < start) {
        if (now < startTime) {
            // End time is "today", start was yesterday
            startTime.setDate(startTime.getDate() - 1);
        } else {
            // End time is tomorrow
            endTime.setDate(endTime.getDate() + 1);
        }
    }

    if (now >= startTime && now <= endTime) {
        return Math.floor((endTime - now) / 1000); // seconds left
    }
    return -1;
}

// === AVAILABILITY CHECK ===
async function checkAvailability() {
    availabilityID = null;
    if (!isLoggedIn()) {
        console.terror('[Login] Not logged in, cannot check availability');
        initializeID ??= setInterval(initializeWhenReady, 1000);
        return;
    }
    const now = new Date();
    if (lastCheckTime && (now - lastCheckTime) < 1000 * 60 * INTERVAL_MINUTES_MIN) {
        console.tlog(`[Monitor] Last check was too recent, skipping this check.`);
        return; // Skip this check if last check was too recent
    }
    lastCheckTime = now; // Update last check time
    const accountCourseType = document.querySelector('#app').__vue__?.$store.state.booking.activeCourseList || [];
    if (!accountCourseType || accountCourseType.length === 0) {
        scheduleNextCheck();
        return;
    }

    const seconds_till_restart = secondsUntilEnd(sleep_time);
    if (seconds_till_restart > 0) {
        console.tlog(`[Monitor] Sleep time, restarting at ${sleep_time[1]}`)
        scheduleNextCheck(seconds_till_restart * 1000 + randomizedInterval());
        return;
    }

    // Check availability for the specified course type
    for (const course of accountCourseType) {
        if (course.courseType === '2B' && check2B) {
            try {
                switchCourse(null, '2B');
                console.tlog(`[Monitor] Checking availability for course type: ${course.courseType}`);
                await new Promise((resolve) => {
                    setTimeout(async () => {
                        resolve(await class2BcheckAvailability());
                    }, 5000);
                });
            } catch (error) {
                console.terror(error)
                console.tlog(`[Monitor] Error in monitoring 2B, ${check_tries} tries left`);
                check_tries -= 1;
                if (check_tries <= 0) {
                    await showNotification("Error in monitoring 2B", "Error in monitoring exceeded max tries. Please check manually.")
                    throw error;
                }
            }
        } else if (course.courseType === '3C' && check3C) {
            try {
                switchCourse(null, '3C');
                console.tlog(`[Monitor] Checking availability for course type: ${course.courseType}`);
                await new Promise((resolve) => {
                    setTimeout(async () => {
                        resolve(await class3checkAvailability());
                    }, 5000);
                });
            } catch (error) {
                console.terror(error)
                console.tlog(`[Monitor] Error in monitoring 3C, ${check_tries} tries left`);
                check_tries -= 1;
                if (check_tries <= 0) {
                    await showNotification("Error in monitoring 3C", "Error in monitoring exceeded max tries. Please check manually.")
                    throw error;
                }
            }
        }
    }
    scheduleNextCheck(randomizedInterval());
}

// Set up randomized recurring checks
function scheduleNextCheck(interval = 1000) {
    console.tlog(`[Monitor] Next check in ${(interval / 1000 / 60).toFixed(2)} minutes`);
    availabilityID ??= setTimeout(checkAvailability, interval);
}

function initCourseSelection() {
    const vue = document.querySelector('#app').__vue__;
    if (vue.$store.state.user.courseType !== '') {
        console.tlog('[Login] Course type already selected:', vue?.$store.state.user.courseType);

        // Cancel scheduled refresh if set below in wait for auto redirect
        if (refreshTimeoutId !== null) {
            concole.tlog('[Login] Sucessfully redirected, cancelling scheduled refresh.');
            clearTimeout(refreshTimeoutId);
            refreshTimeoutId = null; // Reset
        }

        return true;
    }
    const courseList = vue.$store.state.booking.activeCourseList;
    if (courseList.length === 0) {
        console.terror('[Login] No active course list found. Please ensure you are logged in.');
        return false;
    } else if (courseList.length === 1) {
        console.tlog('[Login] Only one course type found, waiting for auto redirect.');

        // Fallback refresh the page if not auto-redirected
        if (refreshTimeoutId !== null) {
            clearTimeout(refreshTimeoutId);
        }
        console.tlog('[Login] Scheduling a refresh for 5 minutes in case auto redirect fails.');
        refreshTimeoutId = setTimeout(() => {
            location.reload(); // Refresh the page
        }, 5 * 60 * 1000); // 5 minutes in milliseconds

        return false; // Wait for auto redirect
    }
    if (check3C) {
        switchCourse(null, '3C');
    } else if (check2B) {
        switchCourse(null, '2B');
    } else {
        console.terror('[Login] No suitable course type found for practical booking.');
        return false; // No course type selected
    }
}

function switchCourse(index = null, courseName = ''){
    const vue = document.querySelector('#app').__vue__;
    if (vue.$store.state.user.userInfo.courseType === courseName) {
        console.tlog('[Login] Course type already selected:', courseName);
        return;
    }
    const courseList = vue.$store.state.booking.activeCourseList;
    console.tlog(courseList);
    if (index === null && courseName) {
        index = courseList.map(item => item.courseType).indexOf(courseName);
    }
    console.log(index);
    if (index === null){
        throw new Error(`Course type ${courseName} not found in list ${courseList}`);
    }
    const course = courseList[index];
    console.tlog(`[Login] Selecting course type: ${course.courseType}`);
    const {
        accountBal: accountBal,
        enrExpiryDateStr: enrExpiryDateStr,
        authToken: authToken,
        courseActiveStatus: courseActiveStatus,
        canDoBooking: canDoBooking,
        canDoPracticalBooking: canDoPracticalBooking,
        courseType: courseType,
        handBookInd: handBookInd
    } = course;
    vue.$store.commit("user/set_courseType", courseType);
    vue.$store.commit("user/set_accountBal", accountBal);
    vue.$store.commit("user/set_expiryDate", enrExpiryDateStr);
    vue.$store.commit("user/set_authToken", authToken);
    vue.$store.commit("user/set_courseActiveStatus", courseActiveStatus);
    vue.$store.commit("user/set_global_canDoBooking", canDoBooking);
    vue.$store.commit("user/set_canDoPracticalBooking", canDoPracticalBooking);
    vue.$store.commit("user/set_showHandBookInd", handBookInd);
    vue.$router.push("/"); // Wait for auto redirect

    // Fallback refresh the page if not auto-redirected
    if (refreshTimeoutId !== null) {
        clearTimeout(refreshTimeoutId);
    }
    console.tlog('[Login] Scheduling a refresh for 5 minutes in case auto redirect fails.');
    refreshTimeoutId = setTimeout(() => {
        location.reload(); // Refresh the page
    }, 5 * 60 * 1000); // 5 minutes in milliseconds
}

function isLoggedIn() {
    return document.querySelector('#app').__vue__?.$store.state.user.userName !== '';
}

function getAuthToken() {
    return decodeURIComponent(document.cookie.split('; ')
        .find(cookie => cookie.startsWith('bbdc-token='))
        ?.split('=')[1] || '');
}

function getJsessionId() {
    try {
        return document.querySelector('#app').__vue__?.$store?.state?.user?.authToken || '';
    } catch (e) {
        console.terror('[Login] Failed to parse vuex:', e);
        return '';
    }
}

function setupMessage(body, tokenInHeader = true) {
    const headers = {
        'content-type': 'application/json',
    };
    if (tokenInHeader) {
        headers.authorization = getAuthToken();
        headers.jsessionid = getJsessionId();
    } else {
        headers.jsessionid = '';
    }
    const requestOptions = {
        method: 'POST',
        headers: headers,
        body: body,
        referrer: 'https://booking.bbdc.sg/',
        credentials: 'include',
        mode: "cors",
        onerror: (err) => console.terror('[Fetch] Request failed:', err),
    }
    return requestOptions;
}

// === MAIN FUNCTIONS ===
// GLobal vars
const availabilityMap2B = {};
const availabilityMap3C = {};

async function fetchAndProcessData(url, requestOptions, tries=3) {
    console.tlog('[Monitor] Sending request to:', url);
    console.tlog('[Monitor] Request options:', requestOptions);
    try {
        const response = await fetch(url, requestOptions);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data?.message === 'No access token.' || data?.message === 'Token expired.') {
            console.terror('[Login] No access token found. Please log in to BBDC.');
            console.tlog('[Fetch] Response data:', data);
            // initializeID ??= setInterval(initializeWhenReady, 1000);
            location.reload(true);
            return null;
        }
        return data;
    } catch (error) {
        console.terror('[Fetch] Fetch failed:', error);
        if (tries > 0) {
            tries = tries - 1;
            console.terror(`[Fetch] Trying fetch (${tries} tries left).`, error);
            const retry_data = await fetchAndProcessData(url, requestOptions, tries=tries);
            return retry_data;
        }
        console.terror('[Fetch] No more tries available.', error);
        showErrorNotification(`[Fetch] Request failed: ${error.message}`);
        return null;
    }
}

async function class2BfindLastLesson() {
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/booking/c2practical/listPracticalTrainings';
    const requestOptions = setupMessage(
        JSON.stringify({
            courseType: "2B",
            pageNo: 1,
            pageSize: 10,
            courseSubType: 'Practical'
        })
    );
    if (requestOptions === null) return null; // If not logged in, return null
    console.tlog('[Monitor] Sending request to find available lesson...');
    const data = await fetchAndProcessData(REQUEST_URL, requestOptions);
    if (data === null) return;
    console.tlog('[Monitor] Available lessons data:', data);
    const trainingList = data?.data?.practicalTrainings || [];
    const sorted_data = trainingList.filter(training => training.canDoBooking).sort((a, b) => {
        const aSubNo = parseFloat(a.subStageSubNo);
        const bSubNo = parseFloat(b.subStageSubNo);
        return bSubNo - aSubNo; // Sort descending
    })
    return sorted_data[0] || null; // Return the most recent lesson or null if none found
}

async function class2BcheckAvailability() {
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/booking/c2practical/listPracSlotReleased';
    if (stageSubDesc === '' || stageSubNo === '' || subVehicleType === '') {
        const lastLesson = await class2BfindLastLesson();
        if (!lastLesson) {
            console.terror('[Monitor] No last lesson found, cannot proceed with availability check');
            showErrorNotification('No last lesson found, cannot proceed with availability check');
            throw new Error('No last lesson found');
        }
        console.tlog('[Monitor] Using last lesson details:', lastLesson);
        stageSubDesc = lastLesson.subDesc;
        subVehicleType = lastLesson.subVehicleType;
        stageSubNo = lastLesson.subStageSubNo;
    }
    const lesson = {
        insInstructorId: '',
        courseType: '2B',
        stageSubDesc: stageSubDesc,
        subVehicleType: subVehicleType,
        stageSubNo: stageSubNo,
    };
    console.tlog('[Monitor] Checking availability for:', lesson);
    let requestOptions = setupMessage(
        JSON.stringify(lesson)
    );
    if (requestOptions === null) return null; // If not logged in, return null
    console.tlog('[Monitor] Sending request...');
    const data = await fetchAndProcessData(REQUEST_URL, requestOptions);
    if (data === null || !data.data?.releasedSlotListGroupByDay) {
        console.terror('[Monitor] Availability check failed:', data);
        document.querySelector('#app').__vue__.$router.push("/");
        return;
    }
    let slotsByDay = data.data.releasedSlotListGroupByDay;
    if (slotsByDay === null) {
        console.tlog('[Monitor] No Class 2B slots available at the moment.');
        availabilityMap2B = {}; // Clear previous availability map
        return;
    }
    if (data?.data?.releasedSlotMonthList.length > 1) {
        lesson.releasedSlotMonth = data.data.releasedSlotMonthList.sort((a, b) => {
            return parseInt(a.slotMonthYm) - parseInt(b.slotMonthYm);
        })[1].slotMonthYm; // Get the later month
        if (lesson.releasedSlotMonth.slice(0, 4) + '-' + lesson.releasedSlotMonth.slice(4) <= DATE_RANGE[1].substring(0, 7)) {
            requestOptions = setupMessage(
                JSON.stringify(lesson)
            );
            const data2 = await new Promise((resolve) => {
                setTimeout(async () => {
                    resolve(await fetchAndProcessData(REQUEST_URL, requestOptions));
                }, 1000); // Wait 1 second before sending the second request
            });
            if (data2 !== null && data2.data?.releasedSlotListGroupByDay) {
                slotsByDay = Object.assign(slotsByDay, data2.data.releasedSlotListGroupByDay);
            }
        }
    }

    for ([date, slots] of Object.entries(slotsByDay)) {
        date = date.split(' ')[0]; // Extract date part only
        if (!availabilityMap2B[date]) {
            availabilityMap2B[date] = {};
        }
        for (let sessionNo = 1; sessionNo <= 8; sessionNo++) {
            const slot = slots.find(s => s.c2psrSessionNo === sessionNo);
            if (slot) {
                isAvailable = slot.bookingProgress === 'Available';
                availabilityMap2B[date][sessionNo] = {
                    isAvailable: isAvailable,
                    startTime: slot.startTime,
                    endTime: slot.endTime,
                    new: isAvailable && (!availabilityMap2B[date][sessionNo] || !availabilityMap2B[date][sessionNo].isAvailable),
                    taken: !isAvailable && availabilityMap2B[date][sessionNo] && availabilityMap2B[date][sessionNo].isAvailable,
                    slotId: slot.slotId,
                    slotIdEnc: slot.slotIdEnc,
                    bookingProgressEnc: slot.bookingProgressEnc,
                    startTime: slot.startTime,
                    totalFee: slot.totalFee,
                    slotRefDate: slot.slotRefDate.split(' ')[0]
                };
            }
        }
    }

    console.tlog('[Monitor] 2B Availability:', availabilityMap2B);
    await notifyAvailableSlots(availabilityMap2B);
    if (tryBook) {
        waitForTelegramResponse(lastTelegramMessageRes, async (response) => {
            const text = response?.message?.text || '';
            if (text) {
                const date = text.split(' ')[0];
                const startTime = text.split('⏰')[1]?.split(' ')[0];
                const slot = Object.values(availabilityMap2B[date]).find(slot => slot.startTime === startTime);
                if (slot && slot.isAvailable) {
                    console.tlog('[Booking] User trying to book', slot);
                    await book2BPracticalSlot(slot);
                }
            }
        }, false);
    }
}

async function noActive2BpracticalBooking() {
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/booking/c2practical/checkExistsActivePracticalBooking';
    const requestOptions = setupMessage(
        JSON.stringify({
            stageSubNo: stageSubNo
        })
    );
    console.tlog('[Booking] Sending request to check active booking...');
    const data = await fetchAndProcessData(REQUEST_URL, requestOptions);
    console.tlog('[Booking] Active booking check response:', data);
    return data?.message === 'Nothing';
}

async function class2BcheckClash(slotList) {
    const date = slotList[0].slotRefDate.split(' ')[0];
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/booking/manage/updateSlotListClashStatus';
    const requestOptions = setupMessage(
        JSON.stringify({
            releasedSlotDate: date,
            slotIdList: slotList
                .filter(slot => slot.isAvailable)
                .map(slot => slot.slotId),
            bookingType: 'Practical',
            subVehicleType: subVehicleType
        })
    );
    console.tlog('[Booking] Sending clash check request', requestOptions);
    const data = await fetchAndProcessData(REQUEST_URL, requestOptions);
    if (data === null) return;
    console.tlog('[Booking] Clash check response:', data);
    const clashStatus = data.data?.updateClashStatusList.map(slot => ({
        slotId: slot.slotId,
        clash: slot.clashedFlag
    })) || [];
    return clashStatus;
}

async function getCaptchaImage() {
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/booking/manage/getCaptchaImage';
    const requestOptions = setupMessage('{}');
    console.tlog('[Captcha] Sending request to get captcha image...');
    const responseData = await fetchAndProcessData(REQUEST_URL, requestOptions);
    console.tlog('[Captcha] Response:', responseData);
    const data = await responseData?.data;
    if (!(await data?.image)) {
        throw new Error('No image data received');
    }
    return data;
}

async function callBookPracticalSlot(captchaToken, verifyCodeId, captchaText, slot) {
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/booking/c2practical/callBookPracticalSlot';
    const requestOptions = setupMessage(
        JSON.stringify({
            courseType: '2B',
            slotIdList: [slot.slotId],
            encryptSlotList: [{
                slotIdEnc: slot.slotIdEnc,
                bookingProgressEnc: slot.bookingProgressEnc
            }],
            verifyCodeId: verifyCodeId,
            verifyCodeValue: captchaText,
            captchaToken: captchaToken,
            insInstructorId: '',
            subVehicleType: subVehicleType
        })
    );
    console.tlog('[Booking] Sending booking request...');
    const data = await fetchAndProcessData(REQUEST_URL, requestOptions);
    if (data === null) return;
    console.tlog('[Booking] Booking response:', data);
    if (data?.success) {
        await showNotification(
            '🎉 Booking Successful!',
            `Your booking for ${slot.startTime} on ${slot.slotRefDate} (\$${slot.totalFee.toFixed(2)}) has been confirmed.`
        );
    } else {
        await showNotification(
            '⚠️ Booking Failed',
            `Booking failed: ${data?.message || 'Unknown error'}\nManual intervention required.`
        );
        disabled = true; // Disable further actions
    }
}

async function book2BPracticalSlot(slot) {
    const canBook = await noActive2BpracticalBooking();
    if (!canBook) {
        console.terror('[Booking] Cannot book, active booking exists');
        await sendTelegramNotification(
            'You have an active booking for a 2B practical lesson. Please cancel it before proceeding.'
        );
        return;
    }
    const date = slot.slotRefDate.split(' ')[0];
    const slotList = Object.values(availabilityMap2B[date]);
    if (!slotList.some(s => s.slotId === slot.slotId && s.isAvailable)) {
        console.terror('[Booking] Slot not found in availability map');
        await sendTelegramNotification(
            `The selected slot (${slot.slotId}) is not available for booking. Please try again later.`
        );
        return;
    }
    const clashStatus = await class2BcheckClash(slotList);
    console.tlog('[Booking] Clash status:', clashStatus);
    if (clashStatus.some(s => s.clash)) {
        console.terror('[Booking] Booking clash detected, cannot proceed with booking');
        await sendTelegramNotification(
            'Booking clash detected, do you have another booking for this slot? Please cancel it before proceeding.'
        );
        return;
    }
    const captchaData = await getCaptchaImage();
    const [captchaToken, verifyCodeId, captchaText] = await dealWithCaptcha(captchaData);
    await callBookPracticalSlot(captchaToken, verifyCodeId, captchaText, slot);
}

async function list2Bbookings() {
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/booking/manage/listAllPracticalBooking';
    const requestOptions = setupMessage(JSON.stringify({
        courseType: '2B'
    }));
    if (requestOptions === null) return null; // If not logged in, return null
    console.tlog('[Booking] Sending request...');
    const data = await fetchAndProcessData(REQUEST_URL, requestOptions);
    console.tlog('[Booking] Booking response:', data);
    return data?.data?.theoryActiveBookingList;
}

async function cancel2BPracticalBooking(slotId) {
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/booking/manage/cancelBooking';
    const requestOptions = setupMessage(
        JSON.stringify({
            bookingId: slotId,
            manageType: 'Practical'
        })
    );
    if (requestOptions === null) return null; // If not logged in, return null
    console.tlog('[Booking] Sending request to cancel booking...');
    const data = await fetchAndProcessData(REQUEST_URL, requestOptions);
    console.tlog('[Booking] Cancel booking response:', data);
    if (data?.success) {
        // Verify that the booking was cancelled
        const bookings = await list2Bbookings();
        if (bookings && bookings.some(booking => booking.slotId === slotId)) {
            console.terror('[Booking] Booking cancellation failed, booking still exists');
            await showNotification(
                '⚠️ Cancel Booking Failed',
                `Failed to cancel booking: ${data?.message || 'Unknown error'}\nManual intervention required.`
            );
            disabled = true; // Disable further actions
            return;
        }
        await showNotification(
            '🎉 Booking Cancelled',
            `Your booking for slot ID ${slotId} has been cancelled successfully.`
        );
    } else {
        await showNotification(
            '⚠️ Cancel Booking Failed',
            `Failed to cancel booking: ${data?.message || 'Unknown error'}\nManual intervention required.`
        );
        disabled = true; // Disable further actions
    }
}

async function notifyAvailableSlots(availabilityMap) {
    const availableSlots = [];
    const newAvailableSlots = [];
    const [startDate, endDate] = DATE_RANGE.map(d => new Date(d));

    // Sort dates chronologically before processing
    const sortedDates = Object.keys(availabilityMap).sort((a, b) => {
        return new Date(a) - new Date(b);
    });

    for (const dateStr of sortedDates) {
        const sessions = availabilityMap[dateStr];
        const slotDate = new Date(dateStr);

        if (slotDate >= startDate && slotDate <= endDate) {
            const formattedDate = slotDate.toISOString().split('T')[0];
            const dayOfWeek = slotDate.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
            const weekend = dayOfWeek === 'SAT' || dayOfWeek === 'SUN';

            for (const sessionNo of Object.keys(sessions).map(Number).sort((a, b) => a - b)) {
                const slotInfo = sessions[sessionNo];
                const peak = weekend || sessionNo > 5;
                if (slotInfo.isAvailable && sessionNo >= MIN_SESSION && (!weekend && sessionNo >= MIN_WEEKDAY_SESSION)) {
                    const text = `${formattedDate} ${dayOfWeek}⏰${slotInfo.startTime} to ${slotInfo.endTime}${peak ? ' (Peak)' : ''}${sessionNo}`;
                    availableSlots.push(text);
                    if (slotInfo.new || slotInfo.taken) {
                        changed = true; // Mark that we found new slots
                    }
                    if (ONLY_SHOW_NEW && !slotInfo.new) continue; // Skip if not new and ONLY_SHOW_NEW is true
                    newAvailableSlots.push(text);
                }
            }
        }
    }

    if (ONLY_SHOW_NEW) {
        if (newAvailableSlots.length > 0){
            await showNotification(
                `🎯 ${newAvailableSlots.length} New Slots Available!`,
                `${newAvailableSlots.join('\n')}`,
                availableSlots
            );
            console.tlog('[Monitor] New available slots in range:', newAvailableSlots);
        }
        // else if (changed) {
        //     await sendTelegramNotification("Options updated", availableSlots, true);
        // }
    } else if (!ONLY_SHOW_NEW && availableSlots.length > 0) {
        await showNotification(
            `🎯 ${availableSlots.length} Slots Available!`,
            `${availableSlots.join('\n')}`,
            availableSlots
        );
        console.tlog('[Monitor] Available slots in range:', availableSlots);
    } else {
        console.tlog(`[Monitor] No${ONLY_SHOW_NEW ? ' new' : ''} available slots found in the specified date range`);
    }
}

async function deleteTelegramMessage(res) {
    if (!res || !res.result || !res.result.message_id) {
        console.terror('[Telegram] Invalid response for deleting message:', res);
        return;
    }
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`;
    const body = {
        chat_id: CHAT_ID,
        message_id: res.result.message_id
    };
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
    } catch (error) {
        console.terror("[Telegram] Error deleting message:", error);
    }
}

async function showErrorNotification(message) {
    sendTelegramNotification(message);
    await showNotification(
        '⚠️ Booking Monitor Error',
    );
}

function randomizedInterval(min = INTERVAL_MINUTES_MIN, max = INTERVAL_MINUTES_MAX) {
    return Math.floor(((Math.random() * (max - min)) + min) * 60 * 1000);
}

async function class3checkAvailability() {
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/booking/c3practical/checkExistsC3PracticalTrainingSlot';
    const requestOptions = setupMessage(
        JSON.stringify({
            subStageSubNo: null,
            insInstructorId: ''
        })
    );
    if (requestOptions === null) return null; // If not logged in, return null
    console.tlog('[Monitor] Sending request...');
    const data = await fetchAndProcessData(REQUEST_URL, requestOptions);
    if (data === null) {
        console.terror('[Monitor] Availability check failed:', data);
        document.querySelector('#app').__vue__.$router.push("/");
        return;
    }
    let slotsByDay = data.data.releasedSlotListGroupByDay;
    if (slotsByDay === null) {
        console.tlog('[Monitor] No Class 3 slots available at the moment.');
        availabilityMap3C = {}; // Clear previous availability map
        return;
    }
    if (data?.data?.releasedSlotMonthList.length > 1) {
        lesson.releasedSlotMonth = data.data.releasedSlotMonthList.sort((a, b) => {
            return parseInt(a.slotMonthYm) - parseInt(b.slotMonthYm);
        })[1].slotMonthYm; // Get the later month
        if (lesson.releasedSlotMonth.slice(0, 4) + '-' + lesson.releasedSlotMonth.slice(4) <= DATE_RANGE[1].substring(0, 7)) {
            requestOptions = setupMessage(
                JSON.stringify(lesson)
            );
            const data2 = await new Promise((resolve) => {
                setTimeout(async () => {
                    resolve(await fetchAndProcessData(REQUEST_URL, requestOptions));
                }, 1000); // Wait 1 second before sending the second request
            });
            if (data2 !== null && data2.data?.releasedSlotListGroupByDay) {
                slotsByDay = Object.assign(slotsByDay, data2.data.releasedSlotListGroupByDay);
            }
        }
    }

    for ([date, slots] of Object.entries(slotsByDay)) {
        date = date.split(' ')[0]; // Extract date part only
        if (!availabilityMap3C[date]) {
            availabilityMap3C[date] = {};
        }
        for (let sessionNo = 1; sessionNo <= 8; sessionNo++) {
            const slot = slots.find(s => s.c2psrSessionNo === sessionNo);
            if (slot) {
                isAvailable = slot.bookingProgress === 'Available';
                availabilityMap3C[date][sessionNo] = {
                    isAvailable: isAvailable,
                    startTime: slot.startTime,
                    endTime: slot.endTime,
                    new: isAvailable && (!availabilityMap3C[date][sessionNo] || !availabilityMap3C[date][sessionNo].isAvailable),
                    taken: !isAvailable && availabilityMap3C[date][sessionNo] && availabilityMap3C[date][sessionNo].isAvailable,
                    slotId: slot.slotId,
                    slotIdEnc: slot.slotIdEnc,
                    bookingProgressEnc: slot.bookingProgressEnc,
                    startTime: slot.startTime,
                    totalFee: slot.totalFee,
                    slotRefDate: slot.slotRefDate.split(' ')[0]
                };
            }
        }
    }

    console.tlog('[Monitor] 3C Availability:', availabilityMap3C);
    await notifyAvailableSlots(availabilityMap3C);
    if (tryBook) {
        waitForTelegramResponse(lastTelegramMessageRes, async (response) => {
            const text = response?.message?.text || '';
            if (text) {
                const date = text.split(' ')[0];
                const startTime = text.split('⏰')[1]?.split(' ')[0];
                const slot = Object.values(availabilityMap3C[date]).find(slot => slot.startTime === startTime);
                if (slot && slot.isAvailable) {
                    console.tlog('[Booking] User trying to book', slot);
                    // await book2BPracticalSlot(slot);
                }
            }
        }, false);
    }
}

// === UNIVERSAL NOTIFICATION FUNCTION ===
async function showNotification(title, message, options = []) {
    try {
        await sendTelegramNotification(message, options);
    } catch (error) {
        console.terror("[Telegram] Error sending Telegram notification:", error);
    }
    if ('Notification' in window) {
        try {
            // Request permission if needed
            if (Notification.permission !== 'granted') {
                await Notification.requestPermission();
            }

            if (Notification.permission === 'granted') {
                new Notification(title, {
                    body: message,
                    icon: 'https://info.bbdc.sg/favicon.ico'
                });
                return;
            }
        } catch (e) {
            console.terror('[Monitor] Notification error:', e);
        }
    }

    // Fallback to alert()
    console.tlog(`[Monitor] ${title}\n${message}`);
    alert(`${title}\n${message}`);
}

// Function to send Telegram notification
async function sendTelegramNotification(message, options = [], silent = false) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    if (!BOT_TOKEN || !CHAT_ID) {
        return;
    }

    if (!message || message.trim() === "") {
        message = "BBDC: empty message";
    }

    const body = {
        chat_id: CHAT_ID,
        text: message,
        silent: silent
    };

    if (options.length > 0) {
        body.reply_markup = {
            keyboard: options.map(option => [{ text: option }]),
            one_time_keyboard: true,
            resize_keyboard: true
        };
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body)
        });
        lastTelegramMessageRes = await response.json();

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        console.tlog(`[Telegram] Telegram notification sent successfully:\n${message}`);
    } catch (error) {
        console.terror("[Telegram] Error sending Telegram notification:", error);
    }
}

async function login(trySolve=true){
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/auth/checkIdAndPass';
    const requestOptions = setupMessage(
        JSON.stringify({
            userId: userId,
            userPass: userPass,
        }),
        false // No token in header for login request
    );
    if (requestOptions === null) return null; // If not logged in, return null
    console.tlog('[Login] Sending login request...');
    const responseData = await fetchAndProcessData(REQUEST_URL, requestOptions);
    console.tlog('[Captcha] Response:', responseData);

    const data = await getCaptcha();
    const [captchaToken, verifyCodeId, captchaText] = await dealWithCaptcha(data);

    return await new Promise((resolve) => {
        setTimeout(async () => {
            resolve(await captchaLogin(captchaToken, verifyCodeId, captchaText));
        }, 1000);
    });
}

async function dealWithCaptcha(data) {
    const base64Image = data?.image;
    const captchaToken = data?.captchaToken;
    const verifyCodeId = data?.verifyCodeId;
    if (!base64Image) {
        throw new Error('No image data received');
    }
    let [processedImage, captchaText] = await trySolveAndShowCaptcha(base64Image);
    if (!trySolve || !captchaText || captchaText.length !== 5) {
        captchaText = await sendImageAndWaitForResponse(processedImage);
        console.tlog(`[Telegram] Recieved captcha reply from user: ${captchaText}`);
    } else {
        try{
            sendImageToTelegram(processedImage, `Captcha recognized as: ${captchaText}`);
        } catch (error) {}
    }
    return [captchaToken, verifyCodeId, captchaText];
}

async function getCaptcha() {
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/auth/getLoginCaptchaImage';
    const requestOptions = setupMessage(
        '{}',
        false // No token in header for captcha request
    );
    if (requestOptions === null) return null; // If not logged in, return null
    const responseData = await fetchAndProcessData(REQUEST_URL, requestOptions);
    console.tlog('[Captcha] Response:', responseData);
    return responseData?.data;
}

async function trySolveAndShowCaptcha(base64Image) {
    const processedImage = await preprocessCaptcha(base64Image);
    const captchaText = await tesseractRecognizeImage(processedImage);
    console.tlog('[Captcha] Recognized text:', captchaText);

    // Create canvas for processing
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Load image
    const img = new Image();
    img.src = base64Image;
    const processedImg = new Image();
    processedImg.src = processedImage;
    await new Promise(resolve => {img.onload = resolve;});
    await new Promise(resolve => {processedImg.onload = resolve;});

    // Set canvas dimensions
    canvas.width = img.width;
    canvas.height = img.height * 2; // Double height for stacking

    // Draw original image
    ctx.drawImage(img, 0, 0);
    ctx.drawImage(processedImg, 0, img.height); // Draw processed image below original
    const stackedImage = canvas.toDataURL('image/png');
    showCaptchaImage(stackedImage);
    return [stackedImage, captchaText]
}

async function preprocessCaptcha(base64Image) {
    try {
        // Create canvas for processing
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Load image
        const img = new Image();
        img.src = base64Image;
        await new Promise(resolve => {img.onload = resolve;});

        // Set canvas dimensions
        canvas.width = img.width;
        canvas.height = img.height;

        // Draw original image
        ctx.drawImage(img, 0, 0);

        // Step 1: Get image data and find dominant colors
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const colorCounts = {};
        // initialize bounding boxes array
        const boundingBoxes = [];

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i+1];
            const b = data[i+2];

            const colorKey = `${r},${g},${b}`;
            colorCounts[colorKey] = (colorCounts[colorKey] || 0) + 1;
        }

        // Get top 5 colors
        const topColors = Object.entries(colorCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(1, 6)
            .map(item => item[0].split(',').map(Number));
        console.tlog('[Captcha] Top colors:', topColors);

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i+1];
            const b = data[i+2];
            let topColorIndex = -1;

            // Check if pixel matches any top color
            for (const [index, [tr, tg, tb]] of topColors.entries()) {
                if (r === tr && g === tg && b === tb) {
                    topColorIndex = index;
                    break;
                }
            }
            if (topColorIndex === -1) {
                // Set to white
                data[i] = data[i+1] = data[i+2] = 255;
            } else {
                data[i] = topColorIndex;
                if (!boundingBoxes[topColorIndex]) {
                    boundingBoxes[topColorIndex] = {};
                }
                x = Math.floor((i / 4) % canvas.width);
                y = Math.floor((i / 4) / canvas.width);
                boundingBoxes[topColorIndex].x = Math.min(boundingBoxes[topColorIndex].x ?? x, x);
                boundingBoxes[topColorIndex].y = Math.min(boundingBoxes[topColorIndex].y ?? y, y);
                boundingBoxes[topColorIndex].maxX = Math.max(boundingBoxes[topColorIndex].maxX ?? x, x);
                boundingBoxes[topColorIndex].maxY = Math.max(boundingBoxes[topColorIndex].maxY ?? y, y);
                boundingBoxes[topColorIndex].index = topColorIndex;
            }
        }
        for (const box of boundingBoxes) {
            box.width = box.maxX - box.x + 1;
            box.height = box.maxY - box.y + 1;
            box.originalX = box.x;
        }
        boundingBoxes.sort((a, b) => a.x - b.x);
        console.tlog('[Captcha] Bounding boxes:', boundingBoxes);

        adjustBoundingBoxes(boundingBoxes, imageData.width);

        separatedImageData = createSeparatedImage(imageData, boundingBoxes);

        // Return processed image as base64
        ctx.putImageData(separatedImageData, 0, 0);
        const processedBase64 = canvas.toDataURL('image/png');
        return processedBase64;

    } catch (error) {
        console.terror('[Captcha] Error processing captcha image:', error);
        return base64Image; // Fallback to original image if processing fails
    }
}

function adjustBoundingBoxes(boundingBoxes, imgWidth) {
    const totalWidth = boundingBoxes.reduce((sum, box) => sum + box.width, 0);
    const minDistance = Math.floor((imgWidth - totalWidth) / (boundingBoxes.length + 1));
    boundingBoxes[0].x = minDistance; // Ensure first box starts at minDistance
    for (let i = 1; i < boundingBoxes.length; i++) {
        const prevBox = boundingBoxes[i - 1];
        const currBox = boundingBoxes[i];

        const currentRightEdge = prevBox.x + prevBox.width;
        const desiredPosition = currentRightEdge + minDistance;
        const shift = desiredPosition - currBox.x;
        currBox.x += shift;
    }
}

function createSeparatedImage(originalImage, boundingBoxes) {
    const width = originalImage.width;
    const height = originalImage.height;
    const originalData = originalImage.data;

    // Calculate new width
    const lastBox = boundingBoxes[boundingBoxes.length - 1];
    const newWidth = Math.max(width, lastBox.x + lastBox.width);
    const newImageData = new ImageData(newWidth, height);
    const newData = newImageData.data;

    // Fill with white background (optimized for pure white)
    newData.fill(255);

    // Copy each character to its new position
    for (const box of boundingBoxes) {
        for (let y = 0; y < box.height; y++) {
            for (let x = 0; x < box.width; x++) {
                const origX = box.originalX + x;
                const origY = box.y + y;

                // Only process if within original image bounds
                if (origX < width && origY < height) {
                    const origIndex = (origY * width + origX) * 4;
                    const newIndex = ((box.y + y) * newWidth + (box.x + x)) * 4;

                    if (originalData[origIndex] === box.index) {
                        newData[newIndex] = 0;
                        newData[newIndex + 1] = 0;
                        newData[newIndex + 2] = 0;
                    }
                }
            }
        }
    }

    return newImageData;
}

function showCaptchaImage(base64Image) {
    const img = new Image();
    img.src = base64Image;
    document.body.appendChild(img);
}

async function sendImageAndWaitForResponse(base64ImageData) {
    try {
        // 1. Send the image to Telegram
        const sentMessage = await sendImageToTelegram(base64ImageData);
        const messageId = sentMessage.result.message_id;

        console.tlog('[Telegram] Image sent successfully. Message ID:', messageId);

        // 2. Start checking for responses
        const response = await waitForTelegramResponse(sentMessage);
        if (response === null) {
            sendTelegramNotification('Received reply, but more than 2 minutes has passed, please relogin');
            console.tlog('[Telegram] Received reply, but more than 2 minutes has passed, refreshing page...');
            window.location.reload();
        }
        const text = response?.message?.text

        console.tlog('[Telegram] User responded:', text);
        return text;
    } catch (error) {
        console.terror('[Telegram] Error in sendImageAndWaitForResponse:', error);
        throw error;
    }
}

// Helper function to send image
async function sendImageToTelegram(base64Data, text = 'Please log in again', tries=3) {
    // Remove data URL prefix if present
    const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;

    // Convert base64 to Blob
    const blob = await base64ToBlob(base64Image);
    const formData = new FormData();
    formData.append('chat_id', CHAT_ID);
    formData.append('photo', blob);
    formData.append('caption', text);

    const response = await fetch(url, {
        method: 'POST',
        body: formData
    });

    lastTelegramMessageRes = await response.json();

    if (!response.ok) {
        if (tries >= 0) {
            tries = tries - 1;
            console.terror(`[Telegram] Trying fetch (${tries} tries left).`, lastTelegramMessageRes);
            const retry_data = await sendImageToTelegram(base64Data, text, tries=tries);
            return retry_data;
        }
        console.terror('[Telegram] No more tries available.', lastTelegramMessageRes);
        throw new Error(`Failed to send image: ${response.status}`);
    }
    return lastTelegramMessageRes;
}

// Helper function to wait for user response
async function waitForTelegramResponse(response, callback = null, lookForReplyOnly=true, timeout = 24 * 60 * 60 * 1000, maxWaitTime = 2 * 60 * 1000, checkInterval = 10 * 1000) {
    originalMessageId = response?.result?.message_id;
    if (originalMessageId < lastTelegramMessageRes?.result?.message_id) {
        return null; // Already processed this message
    }
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        try {
            // Get updates from the bot
            const updates = await getBotUpdates();

            // Find replies to our original message
            let reply;
            if (lookForReplyOnly) {
                reply = updates.result.find(update =>
                    update.message?.reply_to_message?.message_id === originalMessageId
                );
            } else {
                reply = updates.result
                    .filter(update => update.message?.message_id > originalMessageId)
                    .sort((a, b) => a.message?.message_id - b.message?.message_id);
                if (reply.length > 0) {
                    reply = reply[0]; // Get the text of the first reply
                } else {
                    reply = null; // No new replies found
                }
            }

            if (reply) {
                if (Date.now() - startTime > maxWaitTime) {
                    return null; // Timeout waiting for response
                } else {
                    if (callback === null) {
                        return reply;
                    }
                    return callback(reply);
                }
            }

            // Wait before checking again
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        } catch (error) {
            console.terror('[Telegram] Error checking for replies:', error);
            // Continue waiting despite errors
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
    }

    throw new Error('Timeout waiting for response');
}

// Helper function to get bot updates
async function getBotUpdates() {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to get updates: ${response.status}`);
    }

    return response.json();
}

// Helper function to convert base64 to Blob
function base64ToBlob(base64) {
    return new Promise((resolve) => {
        const byteCharacters = atob(base64);
        const byteArrays = [];

        for (let offset = 0; offset < byteCharacters.length; offset += 512) {
            const slice = byteCharacters.slice(offset, offset + 512);
            const byteNumbers = new Array(slice.length);

            for (let i = 0; i < slice.length; i++) {
                byteNumbers[i] = slice.charCodeAt(i);
            }

            byteArrays.push(new Uint8Array(byteNumbers));
        }

        resolve(new Blob(byteArrays, { type: 'image/png' }));
    });
}

async function captchaLogin(captchaToken, verifyCodeId, verifyCodeValue) {
    console.tlog('[Login] Attempting captcha login with token:', verifyCodeValue);
    const vue = document.querySelector('#app').__vue__;
    const formData = {
        captchaToken: captchaToken,
        verifyCodeId: verifyCodeId,
        verifyCodeValue: verifyCodeValue,
        userId: userId,
        userPass: userPass
    }
    const res = await vue.$api.user.login(formData);
    const { data, success, message } = res.data;
    if (success) {
        vue.$store.commit('user/set_userName', data.username);
        document.cookie = `bbdc-token=${encodeURIComponent(data.tokenContent)}`
        vue.$store.commit("user/set_loginInfo", {});
        vue.$router.push("/");
        return true;
    } else {
        trySolve = false; // Disable auto solving for next login attempt
        return false;
    }
}

async function tesseractRecognizeImage(base64Image) {
    try {
        const { data: { text } } = await worker.recognize(base64Image, );
        return text.replace(/[^0-9a-z]/gi, '');
    } catch (error) {
        console.terror('[Tesseract] Error recognizing image:', error);
        return '';
    }
}