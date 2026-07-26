# Architecture walkthrough

Today I'm going to explain how the CandidCue audio path works, end to end, with real numbers.

The renderer captures microphone audio at 24kHz, mono, sixteen bits per sample. Every 100 milliseconds it hands a frame across the IPC boundary to the Rust backend. That's 4800 bytes per frame, or about 48 kilobytes per second sustained.

The backend owns the WebSocket. We connect to the Inworld endpoint with an Authorization header, send the transcribe config first, and then stream base64 audio chunks. If the socket drops, we back off starting at 250 milliseconds and give up after five attempts.

Latency budget matters here. The first partial usually lands within 900 milliseconds. Finals take longer, about 1.7 seconds after the speech stops, because the server waits for silence before committing. Our drain timeout is 2.5 seconds, which covers the 95th percentile with headroom.

On cost: streaming transcription runs about $0.29 per hour at current rates. A typical five minute take costs under 3 cents. We budgeted $500 per month for the beta and we're using less than 20% of it.

The alignment engine processes each revision in under 2 milliseconds, even on a 5000 word script. That's the number that keeps the whole thing feeling instant. If that budget ever slips past 20 milliseconds, the display visibly stutters, and presenters notice immediately.

Two failure modes dominate everything else. First, the API key gets revoked and the service answers with error code 7. Second, a stale model identifier from an old build gets forwarded and rejected with code 3. Both used to look identical to a silent microphone. Now they surface as distinct errors within 2 seconds of starting a take.

That's the whole pipeline: capture, stream, transcribe, align, display. Five stages, one clock, no magic.
