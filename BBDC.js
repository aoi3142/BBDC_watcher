// ==UserScript==
// @name         BBDC practical lesson booking monitor
// @version      1.2
// @description  Checks BBDC lesson availability and notifies when slots are available.
// @author       Xinyuan
// @match        https://booking.bbdc.sg/*
// @connect      api.telegram.org
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
            store.subscribeAction({
                before: (action, state) => {
                    console.log("Action: ", action.type, action.payload)
                    if (action.type === 'user/logOut' && !clickedLogout) {
                        console.log('[Monitor] User auto logged out, saving current state...');
                        userInfo.cookie = getAuthToken();
                        userInfo.userName = state.user.userName;
                        userInfo.courseType = state.user.courseType;
                        userInfo.authToken = state.user.authToken;
                    }
                },
                after: (action, state) => {
                    if (action.type === 'user/logOut' && !clickedLogout) {
                        console.log('[Monitor] User auto logged out, restoring previous state...');
                        store.commit("user/set_userName", userInfo.userName);
                        store.commit("user/set_courseType", userInfo.courseType);
                        store.commit("user/set_authToken", userInfo.authToken);
                        store.commit("user/set_global_canDoBooking", true);
                        document.cookie = `bbdc-token=${encodeURIComponent(userInfo.cookie)}`;
                        app.__vue__.$router.push("/"); // Wait for auto redirect
                    } else if (action.type === 'user/logOut' && clickedLogout) {
                        console.log('[Monitor] User clicked logout button, not restoring previous state');
                        clickedLogout = false; // Reset the flag after handling logout
                    }
                }
            })

            // store.subscribe((mutation, state) => {
            //     console.log("Mutation: ", mutation.type, mutation.payload)
            // })

            addLogoutButtonListener(); // Add listener to logout button

            // First run
            console.log('[Monitor] Initializing BBDC Booking Monitor...');
            initializeID ??= setInterval(initializeWhenReady, 1000);
        }
    }, 500);
})();

function addLogoutButtonListener() {
    const logoutButton = document.getElementsByClassName("btn")[0];
    if (logoutButton) {
        console.log('[Monitor] Logout button found:', logoutButton);
        logoutButton.addEventListener("click", function(){
            clickedLogout = true;
        }, true);
        return true; // Successfully added listener
    }
    console.error('[Monitor] Logout button not found, cannot add listener');
    return false; // Logout button not found
}

async function initializeWhenReady() {
    if (isLoggedIn()) {
        if (!logged_in) {
            sendTelegramNotification('Logged in successfully');
            console.log('[Login] Logged in successfully');
            logged_in = true;
            addLogoutButtonListener(); // Ensure logout button listener is added
        }
        if (!initCourseSelection()) {
            clearInterval(initializeID);
            return;
        }
        clearInterval(initializeID);
        initializeID = null;
        console.log('[Monitor] Starting monitoring...');
        checkAvailability();
    } else {
        if (logged_in) {
            console.log('[Login] Logged out, reinitializing...');
        }
        logged_in = false;
        if (!userId || !userPass) {
            clearInterval(initializeID);
        } else {
            console.log('[Login] Attempting to log in...');
            clearInterval(initializeID);
            initializeID = null;
            await login();
        }
    }
}

// === AVAILABILITY CHECK ===
async function checkAvailability() {
    availabilityID = null;
    if (!isLoggedIn()) {
        console.error('[Login] Not logged in, cannot check availability');
        initializeID ??= setInterval(initializeWhenReady, 1000);
        return;
    }
    const now = new Date();
    if (lastCheckTime && (now - lastCheckTime) < 1000 * 60 * INTERVAL_MINUTES_MIN) {
        console.log(`[Monitor] Last check was too recent, skipping this check.`);
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
            console.log(`[Monitor] Checking availability for course type: ${course.courseType}`);
            await class2BcheckAvailability();
        } else if (course.courseType === '3') {
            console.log(`[Monitor] Checking availability for course type: ${course.courseType}`);
            await class3checkAvailability();
        }
    }
    scheduleNextCheck(randomizedInterval());
}

// Set up randomized recurring checks
function scheduleNextCheck(interval = 1000) {
    console.log(`[Monitor] Next check in ${(interval / 1000 / 60).toFixed(2)} minutes`);
    availabilityID ??= setTimeout(checkAvailability, interval);
}

function initCourseSelection() {
    const vue = document.querySelector('#app').__vue__;
    if (vue.$store.state.user.courseType !== '') {
        console.log('[Login] Course type already selected:', vue?.$store.state.user.courseType);
        return true;
    }
    const courseList = vue.$store.state.booking.activeCourseList;
    if (courseList.length === 0) {
        console.error('[Login] No active course list found. Please ensure you are logged in.');
        return false;
    } else if (courseList.length === 1) {
        return false; // Wait for auto redirect
    }
    for (const course of courseList) {
        if (course.canDoPracticalBooking){
            console.log(`[Login] Selecting course type: ${course.courseType}`);
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
    console.error('[Login] No suitable course type found for practical booking.');
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
        console.error('[Login] Failed to parse vuex:', e);
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
        onerror: (err) => console.error('[Fetch] Request failed:', err),
    }
    return requestOptions;
}

// === MAIN FUNCTIONS ===
// GLobal vars
const availabilityMap = {};

async function fetchAndProcessData(url, requestOptions) {
    console.log('[Monitor] Sending request to:', url);
    console.log('[Monitor] Request options:', requestOptions);
    try {
        const response = await fetch(url, requestOptions);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data?.message === 'No access token.') {
            console.error('[Login] No access token found. Please log in to BBDC.');
            console.log('[Fetch] Response data:', data);
            initializeID ??= setInterval(initializeWhenReady, 1000);
            return null;
        }
        return data;
    } catch (error) {
        console.error('[Fetch] Fetch failed:', error);
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
    console.log('[Monitor] Sending request to find available lesson...');
    const data = await fetchAndProcessData(REQUEST_URL, requestOptions);
    if (data === null) return;
    console.log('[Monitor] Available lessons data:', data);
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
            console.error('[Monitor] No last lesson found, cannot proceed with availability check');
            showErrorNotification('No last lesson found, cannot proceed with availability check');
            throw new Error('No last lesson found');
        }
        console.log('[Monitor] Using last lesson details:', lastLesson);
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
    console.log('[Monitor] Checking availability for:', lesson);
    const requestOptions = setupMessage(
        JSON.stringify(lesson)
    );
    if (requestOptions === null) return null; // If not logged in, return null
    console.log('[Monitor] Sending request...');
    const data = await fetchAndProcessData(REQUEST_URL, requestOptions);
    if (data === null || !data.data?.releasedSlotListGroupByDay) {
        console.error('[Monitor] Availability check failed:', data);
        document.querySelector('#app').__vue__.$router.push("/");
        scheduleNextCheck();
        return;
    }
    const slotsByDay = data.data.releasedSlotListGroupByDay;

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

    console.log('[Monitor] Availability:', availabilityMap);
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

        console.log('[Monitor] Available slots in range:', availableSlots);
    } else {
        console.log(`[Monitor] No${ONLY_SHOW_NEW ? ' new' : ''} available slots found in the specified date range`);
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
    console.log('[Monitor] Sending request...');
    const data = await fetchAndProcessData(REQUEST_URL, requestOptions);
    if (data === null) return;
    console.log('[Monitor] Response:', data);

    if (data?.message !== 'There is no slot released for booking at the moment.') {
        await showNotification(
            '🎯 Class 3 Slots Available!',
            'Class 3 practical training slots are available for booking.'
        );
        sendTelegramNotification('Class 3 practical training slots are available for booking.');
        console.log('[Monitor] Class 3 slots available:', data);
    } else {
        if (debugging) {
            await showNotification(
                '⚠️ Class 3 Slots Unavailable',
                'No Class 3 practical training slots available at the moment.'
            );
            sendTelegramNotification('No Class 3 practical training slots available at the moment.');
        }
        console.log('[Monitor] No Class 3 slots available at the moment.');
    }
}

// === UNIVERSAL NOTIFICATION FUNCTION ===
async function showNotification(title, message) {
    try {
        sendTelegramNotification(message);
    } catch (error) {
        console.error("[Telegram] Error sending Telegram notification:", error);
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
            console.error('[Monitor] Notification error:', e);
        }
    }

    // Fallback to alert()
    console.log(`[Monitor] ${title}\n${message}`);
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
        console.log(`[Telegram] Telegram notification sent successfully:\n${message}`);
    } catch (error) {
        console.error("[Telegram] Error sending Telegram notification:", error);
    }
}

async function login(){
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/auth/checkIdAndPass';
    const requestOptions = setupMessage(
        JSON.stringify({
            userId: userId,
            userPass: userPass,
        }),
        false // No token in header for login request
    );
    if (requestOptions === null) return null; // If not logged in, return null
    console.log('[Login] Sending login request...');
    const responseData = await fetchAndProcessData(REQUEST_URL, requestOptions);
    console.log('[Captcha] Response:', responseData);

    const [captchaToken, verifyCodeId, processedImage] = await getCaptcha();
    const captcha = await sendImageAndWaitForResponse(processedImage);
    captchaLogin(captchaToken, verifyCodeId, captcha);
}

async function getCaptcha() {
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/auth/getLoginCaptchaImage';
    const requestOptions = setupMessage(
        '{}',
        false // No token in header for captcha request
    );
    if (requestOptions === null) return null; // If not logged in, return null
    const responseData = await fetchAndProcessData(REQUEST_URL, requestOptions);
    console.log('[Captcha] Response:', responseData);
    const base64Image = await responseData?.data?.image;
    const captchaToken = await responseData?.data?.captchaToken;
    const verifyCodeId = await responseData?.data?.verifyCodeId;
    if (!base64Image) {
        throw new Error('No image data received');
    }
    const processedImage = await preprocessCaptcha(base64Image);
    showCaptchaImage(processedImage);
    return [captchaToken, verifyCodeId, processedImage]
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
        canvas.height = img.height * 2; // Double height for stacking
        
        // Draw original image
        ctx.drawImage(img, 0, 0);
        ctx.drawImage(img, 0, img.height); // Stack the image
        
        // Step 1: Get image data and find dominant colors
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const colorCounts = {};

        for (let i = 0; i < Math.floor(data.length / 2); i += 4) {
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
        console.log('[Captcha] Top colors:', topColors);

        for (let i = Math.floor(data.length / 2); i < data.length; i += 4) {
            const r = data[i];
            const g = data[i+1];
            const b = data[i+2];
            let isTopColor = false;
            
            // Check if pixel matches any top color
            for (const [tr, tg, tb] of topColors) {
                if (r === tr && g === tg && b === tb) {
                    isTopColor = true;
                    break;
                }
            }
            
            if (!isTopColor) {
                // Set to white
                data[i] = data[i+1] = data[i+2] = 255;
            } else {
                // Set to black
                data[i] = data[i+1] = data[i+2] = 0;
            }
        }
        // Return processed image as base64
        ctx.putImageData(imageData, 0, 0);
        const processedBase64 = canvas.toDataURL('image/png');
        return processedBase64;

    } catch (error) {
        console.error('[Captcha] Error processing captcha image:', error);
        return base64Image; // Fallback to original image if processing fails
    }
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

        console.log('[Telegram] Image sent successfully. Message ID:', messageId);

        // 2. Start checking for responses
        const response = await waitForTelegramResponse(messageId);

        console.log('[Telegram] User responded:', response);
        return response;
    } catch (error) {
        console.error('[Telegram] Error in sendImageAndWaitForResponse:', error);
        throw error;
    }
}

// Helper function to send image
async function sendImageToTelegram(base64Data) {
    // Remove data URL prefix if present
    const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;

    // Convert base64 to Blob
    const blob = await base64ToBlob(base64Image);
    const formData = new FormData();
    formData.append('chat_id', CHAT_ID);
    formData.append('photo', blob);
    formData.append('caption', 'Please log in again');

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
                    console.log('[Telegram] Received reply, but more than 2 minutes has passed, refreshing page...');
                    window.location.reload();
                } else {
                return reply.message.text;
                }
            }

            // Wait before checking again
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        } catch (error) {
            console.error('[Telegram] Error checking for replies:', error);
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
        initializeID ??= setInterval(initializeWhenReady, 1000);
        return true;
    } else {
        throw new Error(message);
    }
}