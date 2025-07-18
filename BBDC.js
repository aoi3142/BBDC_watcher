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

(function() {
    'use strict';

    // === CONFIGURATION ===
    const DATE_RANGE = ["2025-07-14", "2025-07-18"];    // Set your desired date range here
    const MIN_SESSION = 1;                              // Earliest session to consider (1-8, 1 for all, 2 for morning after 09:20 etc.)
    const MIN_WEEKDAY_SESSION = 1;                      // Earliest session to consider for weekdays (1-8, 1 for all, 6 for evenings after 19:20 etc.)

    const INTERVAL_MINUTES_MIN = 3;                     // Minimum refresh interval in minutes
    const INTERVAL_MINUTES_MAX = 5;                     // Maximum refresh interval in minutes
    const ONLY_SHOW_NEW = true;                         // Only show new available slots since last check

    // BBDC Booking Details
    // To find these values, inspect the network requests in your browser's developer tools
    // look for request listPracSlotReleased -> Payload
    const stageSubNo = '2.02';                          // Subject code to monitor
    const stageSubDesc = 'Subject 2.2';                 // Description for the subject
    const courseType = '2B';                            // Course type, e.g., '2B'
    const subVehicleType = 'Circuit';                   // Vehicle type, e.g., 'Circuit' for circuit lessons

    // API endpoint and headers
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/booking/c2practical/listPracSlotReleased';
    const REFERRER = 'https://booking.bbdc.sg/';

    function getAuthToken() {
        return decodeURIComponent(document.cookie.split('; ')
            .find(cookie => cookie.startsWith('bbdc-token='))
            ?.split('=')[1] || '');
    }

    function getJsessionId() {
        try {
            const vuexData = JSON.parse(localStorage.getItem('vuex'));
            return vuexData?.user?.authToken || '';
        } catch (e) {
            console.error('Failed to parse vuex:', e);
            return '';
        }
    }

    // === MAIN FUNCTIONS ===
    async function sendRequest() {
        let headers = {
            'authorization': getAuthToken(),
            'content-type': 'application/json',
            'jsessionid': getJsessionId()
        };
        const requestOptions = {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                courseType: courseType,
                insInstructorId: '',
                stageSubDesc: stageSubDesc,
                subVehicleType: subVehicleType,
                stageSubNo: stageSubNo,
            }),
            referrer: REFERRER,
            credentials: 'include',
            method: "POST",
            mode: "cors",
            onerror: (err) => console.error('Request failed:', err),
        };
        console.log('[Monitor] Sending request...');
        console.log('[Monitor] Request options:', requestOptions);
        try {
            const response = await fetch(REQUEST_URL, requestOptions);

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();

        } catch (error) {
            console.error('Fetch failed:', error);
            showErrorNotification(`Request failed: ${error.message}`);
            return null;
        }
    }

    // === AVAILABILITY CHECK ===
    const availabilityMap = {};
    async function checkAvailability() {
        const data = await sendRequest();
        try {
            if (!data) throw new Error('No data received');
            if (!data.data?.releasedSlotListGroupByDay) {
                if (data?.message === 'No access token.') {
                    console.error('No access token found. Please log in to BBDC.');
                    console.log('Response data:', data);
                    showNotification('Logged out', 'Please log in again');
                    initializeWhenReady();
                    return;
                } else {
                    throw new Error('Invalid response format');
                }
            }
        } catch (error) {
            console.error('Processing error:', error);
            showErrorNotification(`Data parsing failed: ${error.message}`);
            console.log('Response data:', data);
            return;
        }

        const slotsByDay = data?.data?.releasedSlotListGroupByDay || {};

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

        console.log('Availability:', availabilityMap);
        notifyAvailableSlots(availabilityMap);
        scheduleNextCheck();
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

            // Also log to console for debugging
            console.log('Available slots in range:', availableSlots);
        } else {
            console.log(`No${ONLY_SHOW_NEW ? ' new' : ''} available slots found in the specified date range`);
        }
    }

    // === NEW ERROR NOTIFICATION FUNCTION ===
    async function showErrorNotification(message) {
        sendTelegramNotification(message);
        await showNotification(
            '⚠️ Booking Monitor Error',
        );
    }

    const randomizedInterval = () => {
        const min = INTERVAL_MINUTES_MIN * 60 * 1000;
        const max = INTERVAL_MINUTES_MAX * 60 * 1000;
        return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    // First run
    async function initializeWhenReady() {
        if (getAuthToken()) {
            console.log('Auth token found, starting monitoring...');
            setTimeout(checkAvailability, 1000);
            setTimeout(initializeWhenReady, 20 * 60 * 1000 + 5000);
        } else {
            console.log('Auth token not found, retrying...');
            if (!userId || !userPass) {
                setTimeout(initializeWhenReady, 1000);
            } else {
                console.log('Attempting to log in...');
                await login();
                console.log('Login successful, starting monitoring...');
                setTimeout(checkAvailability, 5000);
            }
        }
    }
    initializeWhenReady();

    // Set up randomized recurring checks
    const scheduleNextCheck = () => {
        let interval = randomizedInterval();
        console.log(`[Monitor] Next check in ${(interval / 1000 / 60).toFixed(2)} minutes`);
        setTimeout(async () => {
            await checkAvailability();
        }, interval);
    };
})();

// === UNIVERSAL NOTIFICATION FUNCTION ===
async function showNotification(title, message) {
    try {
        sendTelegramNotification(message);
    } catch (error) {
        console.error("Error sending Telegram notification:", error);
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
            console.error('Notification error:', e);
        }
    }

    // Fallback to alert()
    console.log(`${title}\n${message}`);
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
        console.log("Telegram notification sent successfully");
    } catch (error) {
        console.error("Error sending Telegram notification:", error);
    }
}

async function login(){
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/auth/checkIdAndPass';
    let headers = {
        'content-type': 'application/json',
        'jsessionid': '',
    };
    const requestOptions = {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
            userId: userId,
            userPass: userPass,
        }),
        method: "POST",
    };
    console.log('[Login] Sending login request...');
    console.log('[Login] Request options:', requestOptions);
    const response = await fetch(REQUEST_URL, requestOptions);
    const responseData = await response.json();
    console.log('[Captcha] Response:', responseData);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await captcha();
    return;
}

async function captcha() {
    const REQUEST_URL = 'https://booking.bbdc.sg/bbdc-back-service/api/auth/getLoginCaptchaImage';
    const requestOptions = {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'jsessionid': '',
        },
        body: "{}",
        method: "POST",
    };
    const response = await fetch(REQUEST_URL, requestOptions);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const responseData = await response.json();
    console.log('[Captcha] Response:', responseData);
    const base64Image = await responseData?.data?.image;
    const captchaToken = await responseData?.data?.captchaToken;
    const verifyCodeId = await responseData?.data?.verifyCodeId;
    if (!base64Image) {
        throw new Error('No image data received');
    }
    showCaptchaImage(base64Image);
    const captcha = await sendImageAndWaitForResponse(base64Image);
    if (!captcha) {
        throw new Error('No captcha response received');
    }
    await captchaLogin(captchaToken, verifyCodeId, captcha);
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

        console.log('Image sent successfully. Message ID:', messageId);

        // 2. Start checking for responses
        const response = await waitForTelegramResponse(messageId);

        console.log('User responded:', response);
        return response;
    } catch (error) {
        console.error('Error in sendImageAndWaitForResponse:', error);
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
async function waitForTelegramResponse(originalMessageId, timeout = 300000 /* 5 minutes */) {
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
                return reply.message.text;
            }

            // Wait before checking again
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        } catch (error) {
            console.error('Error checking for replies:', error);
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
    vue.$store.dispatch('user/userLogin', {
        captchaToken: captchaToken,
        verifyCodeId: verifyCodeId,
        verifyCodeValue: verifyCodeValue,
        userId: userId,
        userPass: userPass
    }).then(() => {
        vue.$store.commit("user/set_loginInfo", {}),
        vue.$router.push("/")
    })
}