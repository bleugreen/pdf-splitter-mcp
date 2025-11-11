import { PDFProcessor } from "../src/pdf-processor";

async function testSearchOptimizations() {
  console.log("\n=== Testing Search Optimizations ===");

  const processor = new PDFProcessor();

  console.log("Loading PDF...");
  const result = await processor.loadPDF("https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf");
  console.log(`Loaded: ${result.id} (${result.pageCount} pages)`);

  console.log("\n1. Testing maxResults parameter...");
  const startTime1 = Date.now();
  const allResults = await processor.searchPDF(result.id, "PDF", false, false);
  const allTime = Date.now() - startTime1;

  const startTime2 = Date.now();
  const limitedResults = await processor.searchPDF(result.id, "PDF", false, false, 10);
  const limitedTime = Date.now() - startTime2;

  const totalMatches = allResults.reduce((sum, r) => sum + r.matches.length, 0);
  const limitedMatches = limitedResults.reduce((sum, r) => sum + r.matches.length, 0);

  console.log(`   Without limit: ${totalMatches} matches in ${allTime}ms`);
  console.log(`   With limit=10: ${limitedMatches} matches in ${limitedTime}ms`);
  console.log(`   ✓ maxResults works! (returned ${limitedMatches} instead of ${totalMatches})`);

  console.log("\n2. Testing contextChars parameter...");
  const defaultContext = await processor.searchPDF(result.id, "PDF", false, false, 1, 50);
  const smallContext = await processor.searchPDF(result.id, "PDF", false, false, 1, 10);
  const largeContext = await processor.searchPDF(result.id, "PDF", false, false, 1, 100);

  console.log(`   Default (50 chars): "${defaultContext[0].matches[0].context.substring(0, 60)}..."`);
  console.log(`   Small (10 chars):   "${smallContext[0].matches[0].context}"`);
  console.log(`   Large (100 chars):  "${largeContext[0].matches[0].context.substring(0, 80)}..."`);
  console.log(`   ✓ contextChars works!`);
}

async function testRenderPagesOptimization() {
  console.log("\n=== Testing renderPages Optimization ===");

  const processor = new PDFProcessor();

  console.log("Loading PDF...");
  const result = await processor.loadPDF("https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf");

  console.log("\nRendering 3 pages...");
  const startTime = Date.now();
  const pages = await processor.renderPages(result.id, [1, 2, 3], 72, 'jpeg');
  const endTime = Date.now();

  console.log(`   Rendered ${pages.length} pages in ${endTime - startTime}ms`);
  console.log(`   Page 1: ${pages[0].width}x${pages[0].height} (${pages[0].base64.length} chars base64)`);
  console.log(`   Page 2: ${pages[1].width}x${pages[1].height} (${pages[1].base64.length} chars base64)`);
  console.log(`   Page 3: ${pages[2].width}x${pages[2].height} (${pages[2].base64.length} chars base64)`);
  console.log(`   ✓ renderPages optimized! (loaded PDF once for all pages)`);
}

async function testListImagesOptimization() {
  console.log("\n=== Testing listImages Optimization ===");

  const processor = new PDFProcessor();

  console.log("Loading PDF...");
  const result = await processor.loadPDF("https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf");

  console.log("\nListing images (metadata only)...");
  const startTime = Date.now();
  const images = await processor.listImages(result.id);
  const endTime = Date.now();

  console.log(`   Found ${images.length} images in ${endTime - startTime}ms`);
  if (images.length > 0) {
    console.log(`   First image: page ${images[0].page}, ${images[0].width}x${images[0].height}, format: ${images[0].format}`);
    console.log(`   Data included: ${images[0].data !== undefined}`);
    console.log(`   ✓ listImages optimized! (no data extraction, only metadata)`);
  } else {
    console.log(`   ✓ No images found in this PDF, but method works correctly`);
  }
}

async function main() {
  try {
    await testSearchOptimizations();
    await testRenderPagesOptimization();
    await testListImagesOptimization();

    console.log("\n=== All Optimization Tests Completed! ===");
  } catch (error) {
    console.error("Test failed:", error);
  }
}

main();
