// ==UserScript==
// @name         Lesson Booking Monitor
// @version      1.0
// @description  Checks BBDC lesson availability and notifies when slots are available.
// @author       Xinyuan
// @match        https://booking.bbdc.sg/*
// @grant        GM_notification
// ==/UserScript==

(function() {
    'use strict';

    // === CONFIGURATION ===
    const DATE_RANGE = ["2025-07-14", "2025-07-18"];    // Set your desired date range here
    const MIN_SESSION = 1;                              // Earliest session to consider (1-8, 1 for all, 2 for morning after 09:20 etc.)
    const MIN_WEEKDAY_SESSION = 1;                      // Earliest session to consider for weekdays (1-8, 1 for all, 6 for evenings after 19:20 etc.)

    const INTERVAL_MINUTES_MIN = 3;                     // Minimum refresh interval in minutes
    const INTERVAL_MINUTES_MAX = 5;                     // Maximum refresh interval in minutes

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

    // Dynamic headers (will be fetched from storage or extracted)
    let headers = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8,zh-CN;q=0.7,zh;q=0.6',
        'authorization': getAuthToken(),
        'content-type': 'application/json',
        'jsessionid': getJsessionId(),
        'priority': 'u=1, i',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
    };

    // === MAIN FUNCTIONS ===
    async function sendRequest() {
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
    async function checkAvailability() {
        const data = await sendRequest();
        try {
            if (!data) throw new Error('No data received');
            if (!data.data?.releasedSlotListGroupByDay) throw new Error('Invalid response format');
        } catch (error) {
            console.error('Processing error:', error);
            showErrorNotification(`Data parsing failed: ${error.message}`);
            return {};
        }

        const availabilityMap = {};
        const slotsByDay = data?.data?.releasedSlotListGroupByDay || {};

        for (const [date, slots] of Object.entries(slotsByDay)) {
            availabilityMap[date] = {};
            for (let sessionNo = 1; sessionNo <= 8; sessionNo++) {
                const slot = slots.find(s => s.c2psrSessionNo === sessionNo);
                if (slot) {
                    availabilityMap[date][sessionNo] = {
                        isAvailable: slot.bookingProgress === 'Available',
                        startTime: slot.startTime,
                        endTime: slot.endTime
                    };
                }
            }
        }

        console.log('Availability:', availabilityMap);
        notifyAvailableSlots(availabilityMap);
        scheduleNextCheck();
    }

    function notifyAvailableSlots(availabilityMap) {
        const availableSlots = [];
        const [startDate, endDate] = DATE_RANGE.map(d => new Date(d));

        for (const [dateStr, sessions] of Object.entries(availabilityMap)) {
            const slotDate = new Date(dateStr.split(' ')[0]);

            if (slotDate >= startDate && slotDate <= endDate) {
                const formattedDate = slotDate.toISOString().split('T')[0];
                const dayOfWeek = slotDate.toLocaleDateString('en-US', { weekday: 'short' });
                const weekend = dayOfWeek === 'Sat' || dayOfWeek === 'Sun';

                for (const [sessionNo, slotInfo] of Object.entries(sessions)) {
                    const peak = weekend || sessionNo > 5;
                    if (slotInfo.isAvailable && sessionNo >= MIN_SESSION && (!weekend && sessionNo >= MIN_WEEKDAY_SESSION)) {
                        availableSlots.push(
                            `${formattedDate} ${dayOfWeek} ⏰ ${slotInfo.startTime} to ${slotInfo.endTime}${peak ? ' (Peak)' : ''}`
                        );
                    }
                }
            }
        }

        if (availableSlots.length > 0) {
            GM_notification({
                title: `🎯 ${availableSlots.length} Slots Available!`,
                text: `Available in your date range:\n${availableSlots.join('\n')}`,
                timeout: 60000, // 60 seconds
                highlight: true
            });

            // Also log to console for debugging
            console.log('Available slots in range:', availableSlots);
        } else {
            console.log('No available slots found in the specified date range');
        }
    }

    // === NEW ERROR NOTIFICATION FUNCTION ===
    function showErrorNotification(message) {
        GM_notification({
            title: '⚠️ Booking Monitor Error',
            text: message,
            timeout: 60000,
            highlight: true
        });
    }

    const randomizedInterval = () => {
        const min = INTERVAL_MINUTES_MIN * 60 * 1000;
        const max = INTERVAL_MINUTES_MAX * 60 * 1000;
        return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    // First run
    checkAvailability();

    // Set up randomized recurring checks
    const scheduleNextCheck = () => {
        setTimeout(async () => {
            await checkAvailability();
        }, randomizedInterval());
    };
})();