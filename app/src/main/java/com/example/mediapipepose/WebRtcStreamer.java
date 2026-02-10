package com.example.mediapipepose;

import android.content.Context;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;
import androidx.annotation.Nullable;
import com.google.mediapipe.tasks.components.containers.NormalizedLandmark;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
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

    public interface PoseLabelListener {
        void onPoseLabel(String label);
    }

    public interface CommandListener {
        void onCommand(String command);
    }

    public interface CommandEntryListener {
        void onCommandEntry(String entry);
    }

    public interface CommandHistoryListener {
        void onCommandHistory(List<String> entries);
    }

    private final Context context;
    private PeerConnectionFactory peerConnectionFactory;
    private PeerConnection peerConnection;
    private VideoSource videoSource;
    private VideoTrack videoTrack;
    private EglBase eglBase;
    @Nullable
    private VideoTrack remoteVideoTrack;
    @Nullable
    private SurfaceViewRenderer remoteRenderer;
    private WebSocket webSocket;
    private boolean started;
    @Nullable
    private PoseLabelListener poseLabelListener;
    @Nullable
    private CommandListener commandListener;
    @Nullable
    private CommandEntryListener commandEntryListener;
    @Nullable
    private CommandHistoryListener commandHistoryListener;

    public WebRtcStreamer(Context context) {
        this.context = context.getApplicationContext();
    }

    public void start(String signalingUrl) {
        if (started) {
            return;
        }
        started = true;
        initializePeerConnectionFactory();
        createPeerConnection();
        connectWebSocket(buildSignalingUrl(signalingUrl));
    }

    public void stop() {
        started = false;
        if (webSocket != null) {
            webSocket.close(1000, "bye");
            webSocket = null;
        }
        detachRemoteRenderer();
        if (peerConnection != null) {
            peerConnection.close();
            peerConnection = null;
        }
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

    public void setPoseLabelListener(@Nullable PoseLabelListener listener) {
        poseLabelListener = listener;
    }

    public void setCommandListener(@Nullable CommandListener listener) {
        commandListener = listener;
    }

    public void setCommandEntryListener(@Nullable CommandEntryListener listener) {
        commandEntryListener = listener;
    }

    public void setCommandHistoryListener(@Nullable CommandHistoryListener listener) {
        commandHistoryListener = listener;
    }

    public void sendFrame(VideoFrame frame) {
        if (!started || videoSource == null) {
            return;
        }
        videoSource.getCapturerObserver().onFrameCaptured(frame);
    }

    public void sendPoseLandmarks(List<NormalizedLandmark> landmarks) {
        if (!started || webSocket == null || landmarks == null || landmarks.isEmpty()) {
            return;
        }
        try {
            JSONArray landmarkArray = new JSONArray();
            for (NormalizedLandmark landmark : landmarks) {
                JSONArray entry = new JSONArray();
                entry.put(landmark.x());
                entry.put(landmark.y());
                entry.put(landmark.z());
                float visibility = 0f;
                float presence = 0f;
                Optional<Float> visibilityOpt = landmark.visibility();
                Optional<Float> presenceOpt = landmark.presence();
                if (visibilityOpt != null && visibilityOpt.isPresent()) {
                    visibility = visibilityOpt.get();
                }
                if (presenceOpt != null && presenceOpt.isPresent()) {
                    presence = presenceOpt.get();
                }
                entry.put(visibility);
                entry.put(presence);
                landmarkArray.put(entry);
            }
            JSONObject payload = new JSONObject();
            payload.put("type", "pose");
            payload.put("landmarks", landmarkArray);
            sendMessage(payload);
        } catch (JSONException exception) {
            Log.e(TAG, "Failed to send pose landmarks", exception);
        }
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

    private void createPeerConnection() {
        PeerConnection.RTCConfiguration configuration = new PeerConnection.RTCConfiguration(
                Collections.singletonList(
                        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302")
                                .createIceServer()));
        configuration.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        peerConnection = peerConnectionFactory.createPeerConnection(
                configuration,
                new PeerConnectionObserver());
        if (peerConnection == null) {
            return;
        }
        RtpTransceiver transceiver = peerConnection.addTransceiver(
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
    }

    private void connectWebSocket(String url) {
        OkHttpClient client = new OkHttpClient();
        Request request = new Request.Builder().url(url).build();
        webSocket = client.newWebSocket(request, new SignalingWebSocketListener());
    }

    private String buildSignalingUrl(String url) {
        if (url == null || url.isEmpty()) {
            return url;
        }
        String deviceId = Settings.Secure.getString(
                context.getContentResolver(),
                Settings.Secure.ANDROID_ID);
        if (deviceId == null || deviceId.isEmpty()) {
            return url;
        }
        Uri uri = Uri.parse(url);
        String query = uri.getQuery();
        if (query != null && (query.contains("deviceId=") || query.contains("device_id="))) {
            return url;
        }
        String encodedDeviceId = Uri.encode(deviceId);
        Uri.Builder builder = uri.buildUpon();
        if (query == null || query.isEmpty()) {
            builder.encodedQuery("deviceId=" + encodedDeviceId);
        } else {
            builder.encodedQuery(query + "&deviceId=" + encodedDeviceId);
        }
        return builder.build().toString();
    }

    private void sendMessage(JSONObject message) {
        if (webSocket == null) {
            return;
        }
        webSocket.send(message.toString());
    }

    private void createOffer() {
        if (peerConnection == null) {
            return;
        }
        MediaConstraints constraints = new MediaConstraints();
        peerConnection.createOffer(new SdpObserver() {
            @Override
            public void onCreateSuccess(SessionDescription sessionDescription) {
                peerConnection.setLocalDescription(new SimpleSdpObserver(), sessionDescription);
                try {
                    JSONObject payload = new JSONObject();
                    payload.put("type", "offer");
                    payload.put("sdp", sessionDescription.description);
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

    private void handleAnswer(String sdp) {
        if (peerConnection == null) {
            return;
        }
        SessionDescription answer = new SessionDescription(SessionDescription.Type.ANSWER, sdp);
        peerConnection.setRemoteDescription(new SimpleSdpObserver(), answer);
    }

    private void handleCandidate(JSONObject message) throws JSONException {
        if (peerConnection == null) {
            return;
        }
        String sdpMid = message.getString("sdpMid");
        int sdpMLineIndex = message.getInt("sdpMLineIndex");
        String candidate = message.getString("candidate");
        peerConnection.addIceCandidate(new IceCandidate(sdpMid, sdpMLineIndex, candidate));
    }

    private class PeerConnectionObserver implements PeerConnection.Observer {
        @Override
        public void onIceCandidate(IceCandidate candidate) {
            try {
                JSONObject payload = new JSONObject();
                payload.put("type", "candidate");
                payload.put("sdpMid", candidate.sdpMid);
                payload.put("sdpMLineIndex", candidate.sdpMLineIndex);
                payload.put("candidate", candidate.sdp);
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
            createOffer();
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            try {
                JSONObject message = new JSONObject(text);
                String type = message.optString("type", "");
                if ("ready".equals(type)) {
                    createOffer();
                } else if ("answer".equals(type)) {
                    handleAnswer(message.getString("sdp"));
                } else if ("candidate".equals(type)) {
                    handleCandidate(message);
                } else if ("pose-label".equals(type)) {
                    String label = message.optString("label", "");
                    PoseLabelListener listener = poseLabelListener;
                    if (listener != null) {
                        listener.onPoseLabel(label);
                    }
                } else if ("command".equals(type)) {
                    String command = message.optString("text", "").trim();
                    if (!command.isEmpty()) {
                        CommandListener listener = commandListener;
                        if (listener != null) {
                            listener.onCommand(command);
                        }
                    }
                } else if ("command-entry".equals(type)) {
                    JSONObject entry = message.optJSONObject("entry");
                    String formatted = formatCommandEntry(entry);
                    if (!formatted.isEmpty()) {
                        CommandEntryListener listener = commandEntryListener;
                        if (listener != null) {
                            listener.onCommandEntry(formatted);
                        }
                    }
                } else if ("command-history".equals(type)) {
                    JSONArray entries = message.optJSONArray("entries");
                    List<String> result = parseCommandHistory(entries);
                    CommandHistoryListener listener = commandHistoryListener;
                    if (listener != null) {
                        listener.onCommandHistory(result);
                    }
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

    private String formatCommandEntry(@Nullable JSONObject entry) {
        if (entry == null) {
            return "";
        }
        String user = entry.optString("user", "").trim();
        String text = entry.optString("text", "").trim();
        if (text.isEmpty()) {
            return "";
        }
        if (user.isEmpty()) {
            return text;
        }
        return user + ": " + text;
    }

    private List<String> parseCommandHistory(@Nullable JSONArray entries) {
        if (entries == null) {
            return Collections.emptyList();
        }
        List<String> result = new ArrayList<>();
        for (int i = 0; i < entries.length(); i += 1) {
            JSONObject entry = entries.optJSONObject(i);
            String formatted = formatCommandEntry(entry);
            if (!formatted.isEmpty()) {
                result.add(formatted);
            }
        }
        return result;
    }
}
