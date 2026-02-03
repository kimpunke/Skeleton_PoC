package com.example.mediapipepose;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;
import com.google.mediapipe.tasks.components.containers.NormalizedLandmark;
import java.io.BufferedReader;
import java.io.Closeable;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.tensorflow.lite.Interpreter;

public class PoseClassifier implements Closeable {
    public static class Result {
        public final String label;
        public final float confidence;

        public Result(String label, float confidence) {
            this.label = label;
            this.confidence = confidence;
        }
    }

    private final Interpreter interpreter;
    private final List<String> labels;
    private final float[][] inputBuffer;
    private final float[][] outputBuffer;
    private final int inputSize;

    private PoseClassifier(Interpreter interpreter, List<String> labels) {
        this.interpreter = interpreter;
        this.labels = labels;
        int[] inputShape = interpreter.getInputTensor(0).shape();
        int[] outputShape = interpreter.getOutputTensor(0).shape();
        this.inputSize = inputShape[inputShape.length - 1];
        int outputSize = outputShape[outputShape.length - 1];
        this.inputBuffer = new float[1][inputSize];
        this.outputBuffer = new float[1][outputSize];
    }

    public static PoseClassifier createFromAssets(
            Context context,
            String modelPath,
            String labelsPath) throws IOException {
        AssetManager assetManager = context.getAssets();
        MappedByteBuffer modelBuffer = loadModel(assetManager, modelPath);
        Interpreter.Options options = new Interpreter.Options();
        options.setNumThreads(2);
        Interpreter interpreter = new Interpreter(modelBuffer, options);
        List<String> labels = loadLabels(assetManager, labelsPath);
        return new PoseClassifier(interpreter, labels);
    }

    public synchronized Result classify(List<NormalizedLandmark> landmarks) {
        if (landmarks == null || landmarks.isEmpty()) {
            return null;
        }

        float[] input = inputBuffer[0];
        for (int i = 0; i < input.length; i++) {
            input[i] = 0f;
        }

        int limit = Math.min(landmarks.size() * 3, inputSize);
        int index = 0;
        for (NormalizedLandmark landmark : landmarks) {
            if (index + 2 >= limit) {
                break;
            }
            input[index++] = landmark.x();
            input[index++] = landmark.y();
            input[index++] = landmark.z();
        }

        interpreter.run(inputBuffer, outputBuffer);
        float[] output = outputBuffer[0];
        int bestIndex = 0;
        float bestScore = output[0];
        for (int i = 1; i < output.length; i++) {
            if (output[i] > bestScore) {
                bestScore = output[i];
                bestIndex = i;
            }
        }
        String label = labelForIndex(bestIndex);
        return new Result(label, bestScore);
    }

    private String labelForIndex(int index) {
        if (labels == null || labels.isEmpty()) {
            return "Class " + index;
        }
        if (index >= 0 && index < labels.size()) {
            return labels.get(index);
        }
        return "Class " + index;
    }

    @Override
    public void close() {
        interpreter.close();
    }

    private static MappedByteBuffer loadModel(AssetManager assetManager, String modelPath)
            throws IOException {
        try (AssetFileDescriptor fileDescriptor = assetManager.openFd(modelPath);
             FileInputStream inputStream = new FileInputStream(fileDescriptor.getFileDescriptor());
             FileChannel fileChannel = inputStream.getChannel()) {
            long startOffset = fileDescriptor.getStartOffset();
            long declaredLength = fileDescriptor.getDeclaredLength();
            return fileChannel.map(FileChannel.MapMode.READ_ONLY, startOffset, declaredLength);
        }
    }

    private static List<String> loadLabels(AssetManager assetManager, String labelsPath)
            throws IOException {
        List<String> labels = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(assetManager.open(labelsPath)))) {
            String line;
            while ((line = reader.readLine()) != null) {
                String trimmed = line.trim();
                if (!trimmed.isEmpty()) {
                    labels.add(trimmed);
                }
            }
        }
        return Collections.unmodifiableList(labels);
    }
}
