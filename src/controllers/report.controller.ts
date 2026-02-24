import { Request, Response, NextFunction } from "express";
import prisma from "../utils/prismClient";
import { ApiError } from "../utils/ApiError";
import { analyzeReport } from "../utils/analyzeReport";
import { extractTextFromFile, validateFile } from "../utils/textExtractor";
import * as fs from "fs/promises";
import * as path from "path";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const createReport = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  let file: Express.Multer.File | undefined;

  try {
    const user = (req as any).user;
    if (!user) {
      throw new ApiError(401, "Authentication required");
    }

    if (user.role !== "PATIENT") {
      throw new ApiError(403, "Only patients can upload reports");
    }

    const patientId = user.patient?.id;
    if (!patientId) {
      throw new ApiError(400, "Patient profile not found");
    }

    file = req.file;
    if (!file) {
      throw new ApiError(400, "No file uploaded");
    }

    validateFile(file, MAX_FILE_SIZE_BYTES);

    const report = await prisma.report.create({
      data: {
        patientId,
        filename: file.originalname,
        fileUrl: file.path,
        mimeType: file.mimetype,
        fileSize: file.size,
        status: "PROCESSING",
      },
    });

    processReportInBackground(
      report.id,
      file.path,
      patientId,
      file.originalname
    ).catch((error) => {
      console.error("Background processing error:", error);
    });

    return res.status(202).json({
      success: true,
      message: "Report is being processed",
      data: {
        reportId: report.id,
        status: "PROCESSING",
      },
    });
  } catch (error: unknown) {
    
    if (file?.path) {
      try {
        await fs.unlink(file.path);
      } catch (fsError) {
        console.error("Error cleaning up file:", fsError);
      }
    }

    if (error instanceof ApiError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }

    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    console.error("Error in createReport:", errorMessage);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

async function processReportInBackground(
  reportId: string,
  filePath: string,
  patientId: string,
  filename: string
) {
  try {
    const {
      text: extractedText,
      mimeType,
      fileSize,
    } = await extractTextFromFile(filePath);

    const analysis = await analyzeReport(extractedText);

    await prisma.report.update({
      where: { id: reportId },
      data: {
        extractedText,
        summary: analysis.summary,
        abnormalValues: analysis.abnormal_values as any, 
        possibleConditions: analysis.possible_conditions,
        recommendation: analysis.recommendation,
        disclaimer: analysis.disclaimer,
        status: "COMPLETED",
        mimeType,
        fileSize,
        filename,
      },
    });

    console.log(`Successfully processed report ${reportId}`);

    if (!filePath.startsWith("http://") && !filePath.startsWith("https://")) {
      try {
        await fs.access(filePath);
        await fs.unlink(filePath);
      } catch {
        console.warn(`File ${filePath} does not exist or cannot be deleted`);
      }
    } else {
      console.log(`Cloudinary file ${filePath} will remain in cloud storage`);
    }
  } catch (error) {
    console.error(`Error processing report ${reportId}:`, error);

    await prisma.report.update({
      where: { id: reportId },
      data: {
        status: "FAILED",
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });

    if (!filePath.startsWith("http://") && !filePath.startsWith("https://")) {
      try {
        await fs.access(filePath);
        await fs.unlink(filePath);
      } catch {}
    }
  }
}

export const getReport = async (req: Request, res: Response) => {
  try {
    const { id } = (req as any).params;
    const user = (req as any).user;

    if (!user) {
      throw new ApiError(401, "Authentication required");
    }

    const report = await prisma.report.findUnique({
      where: { id },
      include: { patient: true },
    });

    if (!report) {
      throw new ApiError(404, "Report not found");
    }

    if (user.role !== "ADMIN" && report.patientId !== user.patient?.id) {
      throw new ApiError(403, "You do not have permission to view this report");
    }

    return res.json({
      success: true,
      data: report,
    });
  } catch (error: unknown) {
    console.error("Error getting report:", error);

    if (error instanceof ApiError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }

    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};
