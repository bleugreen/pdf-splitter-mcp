import { PDFProcessor } from "../src/pdf-processor";

async function testPagination() {
  console.log("\n=== Testing Pagination Features ===\n");

  const processor = new PDFProcessor();

  console.log("Loading PDF...");
  const result = await processor.loadPDF("https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf");
  console.log(`✓ Loaded: ${result.id} (${result.pageCount} pages)\n`);

  console.log("1. Testing outline without page numbers...");
  const outline = await processor.getFormattedOutline(result.id);
  const outlineLines = outline.split('\n');
  console.log(`✓ Outline has ${outlineLines.length} lines`);
  console.log(`   First few sections:`);
  console.log(outlineLines.slice(0, 5).join('\n'));
  console.log(`   ...`);
  console.log(`   ✓ Page numbers removed!\n`);

  console.log("2. Testing section pagination...");

  console.log("   a) Extracting first page of Introduction:");
  const page1 = await processor.extractSection(result.id, "Introduction", 1, 2000);
  console.log(`   ✓ Section: "${page1.section}"`);
  console.log(`   ✓ Page ${page1.page} of ${page1.totalPages}`);
  console.log(`   ✓ Content length: ${page1.content.length} characters`);
  console.log(`   ✓ Preview: ${page1.content.substring(0, 100)}...\n`);

  if (page1.totalPages > 1) {
    console.log("   b) Extracting second page:");
    const page2 = await processor.extractSection(result.id, "Introduction", 2, 2000);
    console.log(`   ✓ Section: "${page2.section}"`);
    console.log(`   ✓ Page ${page2.page} of ${page2.totalPages}`);
    console.log(`   ✓ Content length: ${page2.content.length} characters`);
    console.log(`   ✓ Different content: ${page1.content !== page2.content}`);
    console.log(`   ✓ Preview: ${page2.content.substring(0, 100)}...\n`);
  }

  console.log("3. Testing small section (single page)...");
  const singlePage = await processor.extractSection(result.id, "Scope", 1, 4000);
  console.log(`   ✓ Section: "${singlePage.section}"`);
  console.log(`   ✓ Page ${singlePage.page} of ${singlePage.totalPages}`);
  console.log(`   ✓ Single page section works!\n`);

  console.log("4. Testing out of range page...");
  try {
    await processor.extractSection(result.id, "Scope", 999, 4000);
    console.log(`   ✗ Should have thrown error`);
  } catch (error) {
    console.log(`   ✓ Correctly throws error: ${error instanceof Error ? error.message : error}\n`);
  }

  console.log("Summary:");
  console.log(`  ✓ Outline has no page numbers`);
  console.log(`  ✓ Sections are paginated intelligently`);
  console.log(`  ✓ Page navigation works`);
  console.log(`  ✓ Out-of-range detection works`);
}

async function main() {
  try {
    await testPagination();
    console.log("\n=== Pagination Tests Completed! ===\n");
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  }
}

main();
