import { PDFProcessor } from "../src/pdf-processor";
import { existsSync } from "fs";
import { readFile, rm, writeFile } from "fs/promises";
import path from "path";
import os from "os";

const cacheDir = path.join(os.homedir(), '.pdf-splitter-mcp');
const cacheFile = path.join(cacheDir, 'cache.json');
const testPdfPath = './test-sample.pdf';

async function createTestPDF(filePath: string) {
  const pdfContent = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 44 >>
stream
BT
/F1 12 Tf
72 720 Td
(Hello World) Tj
ET
endstream
endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000262 00000 n
0000000341 00000 n
trailer
<< /Size 6 /Root 1 0 R >>
startxref
439
%%EOF`, 'utf-8');

  await writeFile(filePath, pdfContent);
}

async function testFilenameBasedIDs() {
  console.log("\n=== Testing Filename-Based IDs ===");

  const processor = new PDFProcessor();

  const result1 = await processor.loadPDF("./test-sample.pdf");
  console.log(`Loaded PDF with ID: ${result1.id}`);

  if (result1.id.includes("test-sample.pdf")) {
    console.log("✓ ID is filename-based!");
  } else {
    console.log("✗ ID is NOT filename-based:", result1.id);
  }

  const pdfs = await processor.listLoadedPDFs();
  console.log("\nLoaded PDFs:");
  pdfs.forEach(pdf => {
    console.log(`  - ${pdf.id} (${pdf.pageCount} pages)`);
  });
}

async function testCache() {
  console.log("\n=== Testing Cache Persistence ===");

  if (existsSync(cacheFile)) {
    await rm(cacheFile);
    console.log("Cleared existing cache");
  }

  const processor1 = new PDFProcessor();
  const result = await processor1.loadPDF("./test-sample.pdf");
  console.log(`Loaded PDF with ID: ${result.id}`);

  if (existsSync(cacheFile)) {
    console.log("✓ Cache file created!");
    const cacheContent = await readFile(cacheFile, 'utf-8');
    const cacheData = JSON.parse(cacheContent);
    console.log("Cache contents:", JSON.stringify(cacheData, null, 2));
  } else {
    console.log("✗ Cache file NOT created");
  }

  console.log("\nCreating new PDFProcessor instance (simulating server restart)...");
  const processor2 = new PDFProcessor();
  await processor2.restoreCache();

  const pdfs = await processor2.listLoadedPDFs();
  console.log("\nPDFs after restore:");
  pdfs.forEach(pdf => {
    console.log(`  - ${pdf.id} (${pdf.pageCount} pages)`);
  });

  if (pdfs.length > 0) {
    console.log("✓ Cache restored successfully!");

    const text = await processor2.extractPage(pdfs[0].id, 1);
    console.log(`\nExtracted page 1 (first 100 chars): ${text.substring(0, 100)}...`);
    console.log("✓ PDF data fully restored!");
  } else {
    console.log("✗ Cache NOT restored");
  }
}

async function testUnload() {
  console.log("\n=== Testing Unload ===");

  const processor = new PDFProcessor();
  await processor.loadPDF("./test-sample.pdf");

  let pdfs = await processor.listLoadedPDFs();
  console.log(`Loaded PDFs: ${pdfs.length}`);

  if (pdfs.length > 0) {
    const pdfId = pdfs[0].id;
    console.log(`Unloading: ${pdfId}`);
    const removed = await processor.unloadPDF(pdfId);

    if (removed) {
      console.log("✓ PDF unloaded successfully!");

      pdfs = await processor.listLoadedPDFs();
      console.log(`Loaded PDFs after unload: ${pdfs.length}`);

      if (existsSync(cacheFile)) {
        const cacheContent = await readFile(cacheFile, 'utf-8');
        const cacheData = JSON.parse(cacheContent);
        console.log("Cache after unload:", JSON.stringify(cacheData, null, 2));
        console.log("✓ Cache updated!");
      }
    } else {
      console.log("✗ Failed to unload PDF");
    }
  }
}

async function testCollisions() {
  console.log("\n=== Testing ID Collision Handling ===");

  const processor = new PDFProcessor();

  const result1 = await processor.loadPDF("./test-sample.pdf");
  console.log(`First load: ${result1.id}`);

  const result2 = await processor.loadPDF("./test-sample.pdf");
  console.log(`Reload same file: ${result2.id}`);

  if (result1.id === result2.id) {
    console.log("✓ Same file gets same ID!");
  } else {
    console.log("✗ Same file got different IDs");
  }

  const pdfs = await processor.listLoadedPDFs();
  console.log(`Total PDFs loaded: ${pdfs.length}`);

  if (pdfs.length === 1) {
    console.log("✓ Reload didn't create duplicate!");
  } else {
    console.log("✗ Reload created duplicate");
  }
}

async function main() {
  try {
    console.log("Setting up test PDF...");
    await createTestPDF(testPdfPath);

    await testFilenameBasedIDs();
    await testCache();
    await testUnload();
    await testCollisions();

    console.log("\n=== All Tests Completed! ===");

    console.log("\nCleaning up...");
    if (existsSync(testPdfPath)) {
      await rm(testPdfPath);
    }
  } catch (error) {
    console.error("Test failed:", error);
    if (existsSync(testPdfPath)) {
      await rm(testPdfPath);
    }
  }
}

main();
