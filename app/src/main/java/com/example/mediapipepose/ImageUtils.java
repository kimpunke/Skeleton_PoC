package com.example.mediapipepose;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.PixelFormat;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.YuvImage;
import androidx.camera.core.ImageProxy;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import org.webrtc.JavaI420Buffer;
import org.webrtc.YuvHelper;

public final class ImageUtils {
    private ImageUtils() {}

    public static Bitmap imageProxyToBitmap(ImageProxy imageProxy, int rotationDegrees) {
        if (imageProxy == null) {
            return null;
        }

        if (imageProxy.getFormat() == PixelFormat.RGBA_8888) {
            return rgbaImageProxyToBitmap(imageProxy, rotationDegrees);
        }

        if (imageProxy.getImage() == null) {
            return null;
        }

        int width = imageProxy.getWidth();
        int height = imageProxy.getHeight();
        byte[] nv21 = yuv420ToNv21(imageProxy);
        YuvImage yuvImage = new YuvImage(nv21, ImageFormat.NV21, width, height, null);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        yuvImage.compressToJpeg(new Rect(0, 0, width, height), 100, out);
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

    private static Bitmap rgbaImageProxyToBitmap(ImageProxy imageProxy, int rotationDegrees) {
        ImageProxy.PlaneProxy[] planes = imageProxy.getPlanes();
        if (planes == null || planes.length == 0) {
            return null;
        }
        int width = imageProxy.getWidth();
        int height = imageProxy.getHeight();
        ImageProxy.PlaneProxy plane = planes[0];
        int rowStride = plane.getRowStride();
        int pixelStride = plane.getPixelStride();
        if (pixelStride != 4) {
            return null;
        }

        ByteBuffer buffer = plane.getBuffer();
        buffer.rewind();
        int rowBytes = width * 4;
        byte[] rgba = new byte[rowBytes * height];
        for (int row = 0; row < height; row++) {
            int rowStart = row * rowStride;
            buffer.position(rowStart);
            buffer.get(rgba, row * rowBytes, rowBytes);
        }

        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        bitmap.copyPixelsFromBuffer(ByteBuffer.wrap(rgba));
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

    public static JavaI420Buffer imageProxyToI420(ImageProxy imageProxy) {
        if (imageProxy == null || imageProxy.getImage() == null) {
            return null;
        }
        int width = imageProxy.getWidth();
        int height = imageProxy.getHeight();
        ImageProxy.PlaneProxy[] planes = imageProxy.getPlanes();
        ByteBuffer yBuffer = planes[0].getBuffer();
        ByteBuffer uBuffer = planes[1].getBuffer();
        ByteBuffer vBuffer = planes[2].getBuffer();
        int yRowStride = planes[0].getRowStride();
        int yPixelStride = planes[0].getPixelStride();
        int uRowStride = planes[1].getRowStride();
        int uPixelStride = planes[1].getPixelStride();
        int vRowStride = planes[2].getRowStride();
        int vPixelStride = planes[2].getPixelStride();

        JavaI420Buffer i420Buffer = JavaI420Buffer.allocate(width, height);
        copyPlane(yBuffer, yRowStride, yPixelStride,
                i420Buffer.getDataY(), i420Buffer.getStrideY(), width, height);

        int chromaWidth = (width + 1) / 2;
        int chromaHeight = (height + 1) / 2;
        copyPlane(uBuffer, uRowStride, uPixelStride,
                i420Buffer.getDataU(), i420Buffer.getStrideU(), chromaWidth, chromaHeight);
        copyPlane(vBuffer, vRowStride, vPixelStride,
                i420Buffer.getDataV(), i420Buffer.getStrideV(), chromaWidth, chromaHeight);
        return i420Buffer;
    }

    public static JavaI420Buffer bitmapToI420(Bitmap bitmap) {
        if (bitmap == null) {
            return null;
        }

        Bitmap argbBitmap = bitmap;
        if (bitmap.getConfig() != Bitmap.Config.ARGB_8888) {
            argbBitmap = bitmap.copy(Bitmap.Config.ARGB_8888, false);
            if (argbBitmap == null) {
                return null;
            }
        }

        int width = argbBitmap.getWidth();
        int height = argbBitmap.getHeight();
        int srcStride = width * 4;
        ByteBuffer srcBuffer = ByteBuffer.allocateDirect(srcStride * height);
        argbBitmap.copyPixelsToBuffer(srcBuffer);
        srcBuffer.rewind();

        JavaI420Buffer i420Buffer = JavaI420Buffer.allocate(width, height);
        try {
            YuvHelper.ABGRToI420(
                    srcBuffer,
                    srcStride,
                    i420Buffer.getDataY(),
                    i420Buffer.getStrideY(),
                    i420Buffer.getDataU(),
                    i420Buffer.getStrideU(),
                    i420Buffer.getDataV(),
                    i420Buffer.getStrideV(),
                    width,
                    height);
        } catch (RuntimeException | UnsatisfiedLinkError error) {
            i420Buffer.release();
            return null;
        }
        return i420Buffer;
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

    private static void copyPlane(
            ByteBuffer source,
            int sourceRowStride,
            int sourcePixelStride,
            ByteBuffer destination,
            int destinationRowStride,
            int width,
            int height) {
        for (int row = 0; row < height; row++) {
            int sourceRowStart = row * sourceRowStride;
            int destinationRowStart = row * destinationRowStride;
            for (int col = 0; col < width; col++) {
                destination.put(
                        destinationRowStart + col,
                        source.get(sourceRowStart + col * sourcePixelStride));
            }
        }
    }

}
