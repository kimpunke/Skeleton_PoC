package com.example.mediapipepose;

import android.content.Context;
import android.util.Log;
import androidx.annotation.Nullable;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONException;
import org.json.JSONObject;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpTransceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.RtpParameters;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoFrame;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

public class WebRtcStreamer {
    private static final String TAG = "WebRtcStreamer";

    private final Context context;
    private PeerConnectionFactory peerConnectionFactory;
    private final Map<String, PeerConnection> peerConnections = new HashMap<>();
    private VideoSource videoSource;
    private VideoTrack videoTrack;
    private EglBase eglBase;
    @Nullable
    private VideoTrack remoteVideoTrack;
    @Nullable
    private SurfaceViewRenderer remoteRenderer;
    private WebSocket webSocket;
    private boolean started;

    public WebRtcStreamer(Context context) {
        this.context = context.getApplicationContext();
    }

    public void start(String signalingUrl) {
        if (started) {
            return;
        }
        started = true;
        initializePeerConnectionFactory();
        connectWebSocket(signalingUrl);
    }

    public void stop() {
        started = false;
        if (webSocket != null) {
            webSocket.close(1000, "bye");
            webSocket = null;
        }
        detachRemoteRenderer();
        for (PeerConnection connection : peerConnections.values()) {
            connection.close();
        }
        peerConnections.clear();
        if (videoSource != null) {
            videoSource.getCapturerObserver().onCapturerStopped();
            videoSource.dispose();
            videoSource = null;
        }
        if (eglBase != null) {
            eglBase.release();
            eglBase = null;
        }
        if (peerConnectionFactory != null) {
            peerConnectionFactory.dispose();
            peerConnectionFactory = null;
        }
    }

    public void setRemoteRenderer(@Nullable SurfaceViewRenderer renderer) {
        remoteRenderer = renderer;
        if (remoteRenderer != null && remoteVideoTrack != null) {
            remoteVideoTrack.addSink(remoteRenderer);
        }
    }

    public void sendFrame(VideoFrame frame) {
        if (!started || videoSource == null) {
            return;
        }
        videoSource.getCapturerObserver().onFrameCaptured(frame);
    }

    private void initializePeerConnectionFactory() {
        PeerConnectionFactory.InitializationOptions options =
                PeerConnectionFactory.InitializationOptions.builder(context)
                        .setEnableInternalTracer(false)
                        .createInitializationOptions();
        PeerConnectionFactory.initialize(options);

        PeerConnectionFactory.Options factoryOptions = new PeerConnectionFactory.Options();
        eglBase = EglBase.create();
        DefaultVideoEncoderFactory encoderFactory = new DefaultVideoEncoderFactory(
                eglBase.getEglBaseContext(), true, true);
        DefaultVideoDecoderFactory decoderFactory = new DefaultVideoDecoderFactory(
                eglBase.getEglBaseContext());
        peerConnectionFactory = PeerConnectionFactory.builder()
                .setOptions(factoryOptions)
                .setVideoEncoderFactory(encoderFactory)
                .setVideoDecoderFactory(decoderFactory)
                .createPeerConnectionFactory();

        videoSource = peerConnectionFactory.createVideoSource(false);
        videoTrack = peerConnectionFactory.createVideoTrack("video", videoSource);
        videoTrack.setEnabled(true);
        videoSource.getCapturerObserver().onCapturerStarted(true);
    }

    private PeerConnection createPeerConnection(String viewerId) {
        if (viewerId == null || viewerId.isEmpty()) {
            return null;
        }
        PeerConnection existing = peerConnections.get(viewerId);
        if (existing != null) {
            return existing;
        }

        PeerConnection.RTCConfiguration configuration = new PeerConnection.RTCConfiguration(
                Collections.singletonList(
                        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302")
                                .createIceServer()));
        configuration.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        PeerConnection connection = peerConnectionFactory.createPeerConnection(
                configuration,
                new PeerConnectionObserver(viewerId));
        if (connection == null) {
            return null;
        }
        peerConnections.put(viewerId, connection);
        RtpTransceiver transceiver = connection.addTransceiver(
                videoTrack,
                new RtpTransceiver.RtpTransceiverInit(
                        RtpTransceiver.RtpTransceiverDirection.SEND_ONLY,
                        Collections.singletonList("stream")));
        if (transceiver != null) {
            RtpParameters parameters = transceiver.getSender().getParameters();
            if (parameters.encodings != null && !parameters.encodings.isEmpty()) {
                RtpParameters.Encoding encoding = parameters.encodings.get(0);
                encoding.maxBitrateBps = 8_000_000;
                encoding.maxFramerate = 30;
                transceiver.getSender().setParameters(parameters);
            }
        }
        return connection;
    }

    private void connectWebSocket(String url) {
        OkHttpClient client = new OkHttpClient();
        Request request = new Request.Builder().url(url).build();
        webSocket = client.newWebSocket(request, new SignalingWebSocketListener());
    }

    private void sendMessage(JSONObject message) {
        if (webSocket == null) {
            return;
        }
        webSocket.send(message.toString());
    }

    private void createOffer(String viewerId) {
        PeerConnection connection = createPeerConnection(viewerId);
        if (connection == null) {
            return;
        }
        MediaConstraints constraints = new MediaConstraints();
        connection.createOffer(new SdpObserver() {
            @Override
            public void onCreateSuccess(SessionDescription sessionDescription) {
                connection.setLocalDescription(new SimpleSdpObserver(), sessionDescription);
                try {
                    JSONObject payload = new JSONObject();
                    payload.put("type", "offer");
                    payload.put("sdp", sessionDescription.description);
                    payload.put("viewerId", viewerId);
                    sendMessage(payload);
                } catch (JSONException exception) {
                    Log.e(TAG, "Failed to send offer", exception);
                }
            }

            @Override
            public void onSetSuccess() {}

            @Override
            public void onCreateFailure(String error) {
                Log.e(TAG, "Offer failed: " + error);
            }

            @Override
            public void onSetFailure(String error) {}
        }, constraints);
    }

    private void handleAnswer(String viewerId, String sdp) {
        PeerConnection connection = peerConnections.get(viewerId);
        if (connection == null) {
            return;
        }
        SessionDescription answer = new SessionDescription(SessionDescription.Type.ANSWER, sdp);
        connection.setRemoteDescription(new SimpleSdpObserver(), answer);
    }

    private void handleCandidate(String viewerId, JSONObject message) throws JSONException {
        PeerConnection connection = peerConnections.get(viewerId);
        if (connection == null) {
            return;
        }
        String sdpMid = message.getString("sdpMid");
        int sdpMLineIndex = message.getInt("sdpMLineIndex");
        String candidate = message.getString("candidate");
        connection.addIceCandidate(new IceCandidate(sdpMid, sdpMLineIndex, candidate));
    }

    private void closePeerConnection(String viewerId) {
        if (viewerId == null || viewerId.isEmpty()) {
            return;
        }
        PeerConnection connection = peerConnections.remove(viewerId);
        if (connection != null) {
            connection.close();
        }
    }

    private class PeerConnectionObserver implements PeerConnection.Observer {
        private final String viewerId;

        private PeerConnectionObserver(String viewerId) {
            this.viewerId = viewerId;
        }

        @Override
        public void onIceCandidate(IceCandidate candidate) {
            try {
                JSONObject payload = new JSONObject();
                payload.put("type", "candidate");
                payload.put("sdpMid", candidate.sdpMid);
                payload.put("sdpMLineIndex", candidate.sdpMLineIndex);
                payload.put("candidate", candidate.sdp);
                payload.put("viewerId", viewerId);
                sendMessage(payload);
            } catch (JSONException exception) {
                Log.e(TAG, "Failed to send ICE", exception);
            }
        }

        @Override
        public void onIceCandidatesRemoved(IceCandidate[] candidates) {}

        @Override
        public void onSignalingChange(PeerConnection.SignalingState newState) {}

        @Override
        public void onIceConnectionChange(PeerConnection.IceConnectionState newState) {}

        @Override
        public void onIceConnectionReceivingChange(boolean receiving) {}

        @Override
        public void onIceGatheringChange(PeerConnection.IceGatheringState newState) {}

        @Override
        public void onAddStream(org.webrtc.MediaStream stream) {}

        @Override
        public void onRemoveStream(org.webrtc.MediaStream stream) {}

        @Override
        public void onDataChannel(org.webrtc.DataChannel dataChannel) {}

        @Override
        public void onRenegotiationNeeded() {}

        @Override
        public void onAddTrack(org.webrtc.RtpReceiver receiver, org.webrtc.MediaStream[] mediaStreams) {
            if (!(receiver.track() instanceof VideoTrack)) {
                return;
            }
            detachRemoteRenderer();
            remoteVideoTrack = (VideoTrack) receiver.track();
            if (remoteRenderer != null) {
                remoteVideoTrack.addSink(remoteRenderer);
            }
        }
    }

    private void detachRemoteRenderer() {
        if (remoteVideoTrack == null || remoteRenderer == null) {
            return;
        }
        remoteVideoTrack.removeSink(remoteRenderer);
        remoteVideoTrack = null;
    }

    private static class SimpleSdpObserver implements SdpObserver {
        @Override
        public void onCreateSuccess(SessionDescription sessionDescription) {}

        @Override
        public void onSetSuccess() {}

        @Override
        public void onCreateFailure(String error) {}

        @Override
        public void onSetFailure(String error) {}
    }

    private class SignalingWebSocketListener extends WebSocketListener {
        @Override
        public void onOpen(WebSocket webSocket, Response response) {
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            try {
                JSONObject message = new JSONObject(text);
                String type = message.optString("type", "");
                String viewerId = message.optString("viewerId", "");
                if ("ready".equals(type)) {
                    if (!viewerId.isEmpty()) {
                        createOffer(viewerId);
                    }
                } else if ("answer".equals(type)) {
                    handleAnswer(viewerId, message.getString("sdp"));
                } else if ("candidate".equals(type)) {
                    handleCandidate(viewerId, message);
                } else if ("viewer-disconnected".equals(type)) {
                    closePeerConnection(viewerId);
                }
            } catch (JSONException exception) {
                Log.e(TAG, "Invalid signaling message", exception);
            }
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, @Nullable Response response) {
            Log.e(TAG, "WebSocket error", t);
        }
    }
}
