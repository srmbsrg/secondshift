// SecondShift missed-call demo simulator.
// Purely client-side scripted demo — clearly labeled as a simulation on the page.

(function () {
    "use strict";

    // Scripted transcript: [speaker, text] — "ai" or "caller".
    // NOTE: demo content only; not a real call.
    var SCRIPT = [
        ["ai", "Thanks for calling Apex Heating & Air — this is SecondShift. How can I help you?"],
        ["caller", "Hi, my AC just quit on me. It's 92 degrees in here."],
        ["ai", "I'm sorry to hear that — let's get you fixed up. Can I have your name?"],
        ["caller", "Mike Torres."],
        ["ai", "Thanks, Mike. What's the address for the service?"],
        ["caller", "1234 Oak Bend Drive, Spring."],
        ["ai", "Got it. And what's the best number to reach you?"],
        ["caller", "713-555-0148."],
        ["ai", "We have an opening tomorrow between 9 and 11. Does that work?"],
        ["caller", "Yeah, 9 works."],
        ["ai", "You're booked, Mike. A tech will be there tomorrow at 9 AM. Anything else I can do?"],
        ["caller", "Nope, that's it. Thanks."],
        ["ai", "You're welcome. Stay cool out there."]
    ];

    var BOOKED_HTML =
        '<strong>\u2713 Job booked</strong><br>' +
        'Tue 9:00 AM &middot; AC repair<br>' +
        'Mike Torres &middot; 1234 Oak Bend Dr, Spring<br>' +
        '<span class="muted">In a real call, this lands straight in your shop\u2019s calendar.</span>';

    var startBtn = document.getElementById("demo-start");
    var transcriptEl = document.getElementById("demo-transcript");
    var callStateEl = document.getElementById("demo-call-state");
    var controlsEl = document.getElementById("demo-controls");
    var running = false;

    function stamp() {
        var d = new Date();
        var h = d.getHours(), m = ("0" + d.getMinutes()).slice(-2);
        var ap = h >= 12 ? "PM" : "AM";
        h = h % 12 || 12;
        return h + ":" + m + " " + ap;
    }

    function scrollDown() {
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    function addMessage(speaker, text) {
        var div = document.createElement("div");
        div.className = "msg " + speaker;
        var body = document.createElement("span");
        body.textContent = text;
        var ts = document.createElement("span");
        ts.className = "ts";
        ts.textContent = stamp();
        div.appendChild(body);
        div.appendChild(ts);
        transcriptEl.appendChild(div);
        scrollDown();
    }

    function typeMessage(speaker, text, done) {
        var div = document.createElement("div");
        div.className = "msg " + speaker + " typing";
        var body = document.createElement("span");
        div.appendChild(body);
        transcriptEl.appendChild(div);
        scrollDown();

        var i = 0;
        var speed = speaker === "ai" ? 18 : 26;
        (function tick() {
            i++;
            body.textContent = text.slice(0, i);
            scrollDown();
            if (i < text.length) {
                setTimeout(tick, speed);
            } else {
                div.classList.remove("typing");
                var ts = document.createElement("span");
                ts.className = "ts";
                ts.textContent = stamp();
                div.appendChild(ts);
                scrollDown();
                setTimeout(done, speaker === "ai" ? 500 : 700);
            }
        })();
    }

    function showBookedCard() {
        var card = document.createElement("div");
        card.className = "booked-card";
        card.innerHTML = BOOKED_HTML;
        transcriptEl.appendChild(card);
        scrollDown();
    }

    function playScript(index) {
        if (index >= SCRIPT.length) {
            callStateEl.textContent = "Call ended";
            showBookedCard();
            controlsEl.innerHTML = '<button class="btn btn-ghost btn-sm" id="demo-replay">Replay demo</button>' +
                '<p class="demo-note">Simulated conversation — no real call was placed.</p>';
            document.getElementById("demo-replay").addEventListener("click", reset);
            running = false;
            return;
        }
        var speaker = SCRIPT[index][0], text = SCRIPT[index][1];
        typeMessage(speaker, text, function () { playScript(index + 1); });
    }

    function reset() {
        transcriptEl.innerHTML = "";
        callStateEl.textContent = "Incoming call…";
        controlsEl.innerHTML = '<button class="btn btn-primary" id="demo-start">Simulate a missed call</button>' +
            '<p class="demo-note">Simulated conversation — no real call was placed.</p>';
        document.getElementById("demo-start").addEventListener("click", start);
    }

    function start() {
        if (running) return;
        running = true;
        transcriptEl.innerHTML = "";
        callStateEl.textContent = "SecondShift answering…";
        controlsEl.innerHTML = '<p class="demo-note">Demo in progress…</p>';
        setTimeout(function () {
            callStateEl.textContent = "Connected — 00:00";
            playScript(0);
        }, 1200);
    }

    if (startBtn && transcriptEl) {
        startBtn.addEventListener("click", start);
    }
})();
