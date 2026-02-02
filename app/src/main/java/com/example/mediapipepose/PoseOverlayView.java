package com.example.mediapipepose;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.util.AttributeSet;
import android.view.View;
import com.google.mediapipe.tasks.components.containers.NormalizedLandmark;
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarkerResult;
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarkerResult;
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarkerResult;
import java.util.ArrayList;
import java.util.List;

public class PoseOverlayView extends View {
    private static final float POSE_LANDMARK_RADIUS = 6f;
    private static final float FACE_LANDMARK_RADIUS = 3f;
    private static final float HAND_LANDMARK_RADIUS = 7f;
    private static final int[][] POSE_CONNECTIONS = new int[][]{
            {0, 1}, {1, 2}, {2, 3}, {3, 7},
            {0, 4}, {4, 5}, {5, 6}, {6, 8},
            {9, 10},
            {11, 12}, {11, 13}, {13, 15}, {15, 17}, {15, 19}, {15, 21}, {17, 19},
            {12, 14}, {14, 16}, {16, 18}, {16, 20}, {16, 22}, {18, 20},
            {11, 23}, {12, 24}, {23, 24},
            {23, 25}, {24, 26}, {25, 27}, {27, 29}, {29, 31},
            {26, 28}, {28, 30}, {30, 32}, {27, 31}, {28, 32}
    };

    public enum RenderMode {
        POSE,
        FACE,
        HAND
    }

    private final Paint linePaint = new Paint();
    private final Paint pointPaint = new Paint();

    private PoseLandmarkerResult poseResult;
    private FaceLandmarkerResult faceResult;
    private HandLandmarkerResult handResult;
    private int imageWidth;
    private int imageHeight;
    private boolean mirror;
    private RenderMode renderMode = RenderMode.POSE;

    public PoseOverlayView(Context context, AttributeSet attrs) {
        super(context, attrs);
        linePaint.setColor(0xFF00E676);
        linePaint.setStrokeWidth(4f);
        linePaint.setStyle(Paint.Style.STROKE);
        linePaint.setAntiAlias(true);

        pointPaint.setColor(0xFFFF5252);
        pointPaint.setStyle(Paint.Style.FILL);
        pointPaint.setAntiAlias(true);
    }

    public void setPoseResults(PoseLandmarkerResult result, int imageWidth, int imageHeight) {
        this.poseResult = result;
        this.faceResult = null;
        this.handResult = null;
        this.imageWidth = imageWidth;
        this.imageHeight = imageHeight;
        this.renderMode = RenderMode.POSE;
        postInvalidate();
    }

    public void setFaceResults(FaceLandmarkerResult result, int imageWidth, int imageHeight) {
        this.poseResult = null;
        this.faceResult = result;
        this.handResult = null;
        this.imageWidth = imageWidth;
        this.imageHeight = imageHeight;
        this.renderMode = RenderMode.FACE;
        postInvalidate();
    }

    public void setHandResults(HandLandmarkerResult result, int imageWidth, int imageHeight) {
        this.poseResult = null;
        this.faceResult = null;
        this.handResult = result;
        this.imageWidth = imageWidth;
        this.imageHeight = imageHeight;
        this.renderMode = RenderMode.HAND;
        postInvalidate();
    }

    public void setMirror(boolean mirror) {
        this.mirror = mirror;
        postInvalidate();
    }

    public void clear() {
        this.poseResult = null;
        this.faceResult = null;
        this.handResult = null;
        postInvalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (imageWidth == 0 || imageHeight == 0) {
            return;
        }

        float scale = Math.max(
                getWidth() / (float) imageWidth,
                getHeight() / (float) imageHeight
        );
        float offsetX = (getWidth() - imageWidth * scale) / 2f;
        float offsetY = (getHeight() - imageHeight * scale) / 2f;

        if (renderMode == RenderMode.POSE) {
            drawPose(canvas, scale, offsetX, offsetY);
        } else if (renderMode == RenderMode.FACE) {
            drawFace(canvas, scale, offsetX, offsetY);
        } else {
            drawHands(canvas, scale, offsetX, offsetY);
        }
    }

    private void drawPose(Canvas canvas, float scale, float offsetX, float offsetY) {
        if (poseResult == null || poseResult.landmarks().isEmpty()) {
            return;
        }

        List<NormalizedLandmark> landmarks = poseResult.landmarks().get(0);
        if (landmarks == null || landmarks.isEmpty()) {
            return;
        }

        List<float[]> points = new ArrayList<>(landmarks.size());
        for (NormalizedLandmark landmark : landmarks) {
            float x = landmark.x() * imageWidth * scale + offsetX;
            float y = landmark.y() * imageHeight * scale + offsetY;
            if (mirror) {
                x = getWidth() - x;
            }
            points.add(new float[]{x, y});
        }

        for (int[] connection : POSE_CONNECTIONS) {
            if (connection[0] < points.size() && connection[1] < points.size()) {
                float[] start = points.get(connection[0]);
                float[] end = points.get(connection[1]);
                canvas.drawLine(start[0], start[1], end[0], end[1], linePaint);
            }
        }

        for (float[] point : points) {
            canvas.drawCircle(point[0], point[1], POSE_LANDMARK_RADIUS, pointPaint);
        }
    }

    private void drawFace(Canvas canvas, float scale, float offsetX, float offsetY) {
        if (faceResult == null || faceResult.faceLandmarks().isEmpty()) {
            return;
        }

        for (List<NormalizedLandmark> landmarks : faceResult.faceLandmarks()) {
            for (NormalizedLandmark landmark : landmarks) {
                float x = landmark.x() * imageWidth * scale + offsetX;
                float y = landmark.y() * imageHeight * scale + offsetY;
                if (mirror) {
                    x = getWidth() - x;
                }
                canvas.drawCircle(x, y, FACE_LANDMARK_RADIUS, pointPaint);
            }
        }
    }

    private void drawHands(Canvas canvas, float scale, float offsetX, float offsetY) {
        if (handResult == null || handResult.landmarks().isEmpty()) {
            return;
        }

        int[][] handConnections = new int[][]{
                {0, 1}, {1, 2}, {2, 3}, {3, 4},
                {0, 5}, {5, 6}, {6, 7}, {7, 8},
                {0, 9}, {9, 10}, {10, 11}, {11, 12},
                {0, 13}, {13, 14}, {14, 15}, {15, 16},
                {0, 17}, {17, 18}, {18, 19}, {19, 20}
        };

        for (List<NormalizedLandmark> landmarks : handResult.landmarks()) {
            List<float[]> points = new ArrayList<>(landmarks.size());
            for (NormalizedLandmark landmark : landmarks) {
                float x = landmark.x() * imageWidth * scale + offsetX;
                float y = landmark.y() * imageHeight * scale + offsetY;
                if (mirror) {
                    x = getWidth() - x;
                }
                points.add(new float[]{x, y});
            }

            for (int[] connection : handConnections) {
                if (connection[0] < points.size() && connection[1] < points.size()) {
                    float[] start = points.get(connection[0]);
                    float[] end = points.get(connection[1]);
                    canvas.drawLine(start[0], start[1], end[0], end[1], linePaint);
                }
            }

            for (float[] point : points) {
                canvas.drawCircle(point[0], point[1], HAND_LANDMARK_RADIUS, pointPaint);
            }
        }
    }
}
