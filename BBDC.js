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
// To find these values, inspect the network requests in your browser's developer tools, look for request listPracSlotReleased -> Payload
// Leave these empty to automatically select the highest bookable subject
let stageSubNo = '';                              // Subject code to monitor
let stageSubDesc = '';                            // Description for the subject
let subVehicleType = '';                          // Vehicle type, e.g., 'Circuit' for circuit lessons
// const stageSubNo = '3.02';
// const stageSubDesc = 'Subject 3.2';
// const subVehicleType = 'Circuit';

// Global vars, do not touch
let logged_in = true;
let lastCheckTime = null; // Track last check time
let initializeID;
let availabilityID;
let clickedLogout = false; // Track if logout button was clicked
const userInfo = {};
const worker = await Tesseract.createWorker('eng');
let disabled = false;
let trySolve = true;

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
            if (await login(trySolve)) {
                console.tlog('[Login] Login done');
                trySolve = true;
                initializeID ??= setInterval(initializeWhenReady, 1000);
            } else {
                sendTelegramNotification('Login failed, manual intervention required');
            }
        }
    }
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

    // Check availability for the specified course type
    for (const course of accountCourseType) {
        if (course.courseType === '2B') {
            console.tlog(`[Monitor] Checking availability for course type: ${course.courseType}`);
            await class2BcheckAvailability();
        } else if (course.courseType === '3') {
            console.tlog(`[Monitor] Checking availability for course type: ${course.courseType}`);
            await class3checkAvailability();
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
        return true;
    }
    const courseList = vue.$store.state.booking.activeCourseList;
    if (courseList.length === 0) {
        console.terror('[Login] No active course list found. Please ensure you are logged in.');
        return false;
    } else if (courseList.length === 1) {
        console.tlog('[Login] Only one course type found, waiting for auto redirect.');
        return false; // Wait for auto redirect
    }
    for (const course of courseList) {
        if (course.canDoPracticalBooking){
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
            return false; // Stop after selecting the first course type
        }
    }
    console.terror('[Login] No suitable course type found for practical booking.');
    return false; // No course type selected
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
const availabilityMap = {};

async function fetchAndProcessData(url, requestOptions) {
    console.tlog('[Monitor] Sending request to:', url);
    console.tlog('[Monitor] Request options:', requestOptions);
    try {
        const response = await fetch(url, requestOptions);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data?.message === 'No access token.') {
            console.terror('[Login] No access token found. Please log in to BBDC.');
            console.tlog('[Fetch] Response data:', data);
            initializeID ??= setInterval(initializeWhenReady, 1000);
            return null;
        }
        return data;
    } catch (error) {
        console.terror('[Fetch] Fetch failed:', error);
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
        scheduleNextCheck();
        return;
    }
    let slotsByDay = data.data.releasedSlotListGroupByDay;
    if (data?.data?.releasedSlotMonthList.length > 1) {
        lesson.releasedSlotMonth = data.data.releasedSlotMonthList.sort((a, b) => {
            return parseInt(a.slotMonthYm) - parseInt(b.slotMonthYm);
        })[1].slotMonthYm; // Get the later month
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

    for (const [date, slots] of Object.entries(slotsByDay)) {
        if (!availabilityMap[date]) {
            availabilityMap[date] = {};
        }
        for (let sessionNo = 1; sessionNo <= 8; sessionNo++) {
            const slot = slots.find(s => s.c2psrSessionNo === sessionNo);
            if (slot) {
                availabilityMap[date][sessionNo] = {
                    isAvailable: slot.bookingProgress === 'Available',
                    startTime: slot.startTime,
                    endTime: slot.endTime,
                    new: slot.bookingProgress === 'Available' && (!availabilityMap[date][sessionNo] || availabilityMap[date][sessionNo].isAvailable === false)
                };
            }
        }
    }

    console.tlog('[Monitor] Availability:', availabilityMap);
    notifyAvailableSlots(availabilityMap);
}

async function notifyAvailableSlots(availabilityMap) {
    const availableSlots = [];
    const [startDate, endDate] = DATE_RANGE.map(d => new Date(d));

    // Sort dates chronologically before processing
    const sortedDates = Object.keys(availabilityMap).sort((a, b) => {
        return new Date(a.split(' ')[0]) - new Date(b.split(' ')[0]);
    });

    for (const dateStr of sortedDates) {
        const sessions = availabilityMap[dateStr];
        const slotDate = new Date(dateStr.split(' ')[0]);

        if (slotDate >= startDate && slotDate <= endDate) {
            const formattedDate = slotDate.toISOString().split('T')[0];
            const dayOfWeek = slotDate.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
            const weekend = dayOfWeek === 'SAT' || dayOfWeek === 'SUN';

            for (const sessionNo of Object.keys(sessions).map(Number).sort((a, b) => a - b)) {
                const slotInfo = sessions[sessionNo];
                const peak = weekend || sessionNo > 5;
                if (slotInfo.isAvailable && sessionNo >= MIN_SESSION && (!weekend && sessionNo >= MIN_WEEKDAY_SESSION)) {
                    if (ONLY_SHOW_NEW && !slotInfo.new) continue; // Skip if not new and ONLY_SHOW_NEW is true
                    availableSlots.push(
                        `${formattedDate} ${dayOfWeek}⏰${slotInfo.startTime} to ${slotInfo.endTime}${peak ? ' (Peak)' : ''}`
                    );
                }
            }
        }
    }

    if (availableSlots.length > 0) {
        await showNotification(
            `🎯 ${availableSlots.length} Slots Available!`,
            `${availableSlots.join('\n')}`
        );

        console.tlog('[Monitor] Available slots in range:', availableSlots);
    } else {
        console.tlog(`[Monitor] No${ONLY_SHOW_NEW ? ' new' : ''} available slots found in the specified date range`);
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
    if (data === null) return;
    console.tlog('[Monitor] Response:', data);

    if (data?.message !== 'There is no slot released for booking at the moment.') {
        await showNotification(
            '🎯 Class 3 Slots Available!',
            'Class 3 practical training slots are available for booking.'
        );
        sendTelegramNotification('Class 3 practical training slots are available for booking.');
        console.tlog('[Monitor] Class 3 slots available:', data);
    } else {
        if (debugging) {
            await showNotification(
                '⚠️ Class 3 Slots Unavailable',
                'No Class 3 practical training slots available at the moment.'
            );
            sendTelegramNotification('No Class 3 practical training slots available at the moment.');
        }
        console.tlog('[Monitor] No Class 3 slots available at the moment.');
    }
}

// === UNIVERSAL NOTIFICATION FUNCTION ===
async function showNotification(title, message) {
    try {
        sendTelegramNotification(message);
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
async function sendTelegramNotification(message) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    if (!BOT_TOKEN || !CHAT_ID) {
        return;
    }

    if (!message || message.trim() === "") {
        message = "BBDC: empty message";
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                chat_id: CHAT_ID,
                text: message
            })
        });

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

    let [captchaToken, verifyCodeId, processedImage, captchaText] = await getCaptcha();
    if (!trySolve || !captchaText || captchaText.length !== 5) {
        captchaText = await sendImageAndWaitForResponse(processedImage);
    } else {
        await sendImageToTelegram(processedImage, `Captcha recognized as: ${captchaText}`);
    }

    return await new Promise((resolve) => {
        setTimeout(async () => {
            resolve(await captchaLogin(captchaToken, verifyCodeId, captchaText));
        }, 5000);
    });
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
    const base64Image = await responseData?.data?.image;
    const captchaToken = await responseData?.data?.captchaToken;
    const verifyCodeId = await responseData?.data?.verifyCodeId;
    if (!base64Image) {
        throw new Error('No image data received');
    }
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
    return [captchaToken, verifyCodeId, stackedImage, captchaText]
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
        const response = await waitForTelegramResponse(messageId);

        console.tlog('[Telegram] User responded:', response);
        return response;
    } catch (error) {
        console.terror('[Telegram] Error in sendImageAndWaitForResponse:', error);
        throw error;
    }
}

// Helper function to send image
async function sendImageToTelegram(base64Data, text = 'Please log in again') {
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

    if (!response.ok) {
        throw new Error(`Failed to send image: ${response.status}`);
    }

    return response.json();
}

// Helper function to wait for user response
async function waitForTelegramResponse(originalMessageId, timeout = 24 * 60 * 60 * 1000) {
    const startTime = Date.now();
    const checkInterval = 3000; // Check every 3 seconds

    while (Date.now() - startTime < timeout) {
        try {
            // Get updates from the bot
            const updates = await getBotUpdates();

            // Find replies to our original message
            const reply = updates.result.find(update =>
                update.message?.reply_to_message?.message_id === originalMessageId
            );

            if (reply) {
                if (Date.now() - startTime > 2 * 60 * 1000) {
                    sendTelegramNotification('Received reply, but more than 2 minutes has passed, please relogin');
                    console.tlog('[Telegram] Received reply, but more than 2 minutes has passed, refreshing page...');
                    window.location.reload();
                } else {
                return reply.message.text;
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