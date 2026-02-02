package com.example.mediapipepose;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.YuvImage;
import androidx.camera.core.ImageProxy;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

public final class ImageUtils {
    private ImageUtils() {}

    public static Bitmap imageProxyToBitmap(ImageProxy imageProxy, int rotationDegrees) {
        if (imageProxy == null || imageProxy.getImage() == null) {
            return null;
        }

        int width = imageProxy.getWidth();
        int height = imageProxy.getHeight();
        byte[] nv21 = yuv420ToNv21(imageProxy);
        YuvImage yuvImage = new YuvImage(nv21, ImageFormat.NV21, width, height, null);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        yuvImage.compressToJpeg(new Rect(0, 0, width, height), 90, out);
        byte[] imageBytes = out.toByteArray();
        Bitmap bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.length);
        if (bitmap == null) {
            return null;
        }

        if (rotationDegrees == 0) {
            return bitmap;
        }

        Matrix matrix = new Matrix();
        matrix.postRotate(rotationDegrees);
        return Bitmap.createBitmap(
                bitmap,
                0,
                0,
                bitmap.getWidth(),
                bitmap.getHeight(),
                matrix,
                true
        );
    }

    private static byte[] yuv420ToNv21(ImageProxy imageProxy) {
        int width = imageProxy.getWidth();
        int height = imageProxy.getHeight();
        int ySize = width * height;
        int uvSize = width * height / 2;
        byte[] nv21 = new byte[ySize + uvSize];

        ImageProxy.PlaneProxy[] planes = imageProxy.getPlanes();
        ByteBuffer yBuffer = planes[0].getBuffer();
        ByteBuffer uBuffer = planes[1].getBuffer();
        ByteBuffer vBuffer = planes[2].getBuffer();

        int yRowStride = planes[0].getRowStride();
        int yPixelStride = planes[0].getPixelStride();
        int offset = 0;

        for (int row = 0; row < height; row++) {
            int yRowStart = row * yRowStride;
            for (int col = 0; col < width; col++) {
                nv21[offset++] = yBuffer.get(yRowStart + col * yPixelStride);
            }
        }

        int uvRowStride = planes[1].getRowStride();
        int uvPixelStride = planes[1].getPixelStride();
        int vRowStride = planes[2].getRowStride();
        int vPixelStride = planes[2].getPixelStride();
        int uvHeight = height / 2;
        int uvWidth = width / 2;

        for (int row = 0; row < uvHeight; row++) {
            int uvRowStart = row * uvRowStride;
            int vRowStart = row * vRowStride;
            for (int col = 0; col < uvWidth; col++) {
                int uIndex = uvRowStart + col * uvPixelStride;
                int vIndex = vRowStart + col * vPixelStride;
                nv21[offset++] = vBuffer.get(vIndex);
                nv21[offset++] = uBuffer.get(uIndex);
            }
        }

        return nv21;
    }
}
