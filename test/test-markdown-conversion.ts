import { PDFProcessor } from "../src/pdf-processor";

async function testMarkdownConversion() {
  console.log("\n=== Testing Markdown Conversion ===\n");

  const processor = new PDFProcessor();

  console.log("Loading PDF...");
  const result = await processor.loadPDF("https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf");
  console.log(`✓ Loaded: ${result.id} (${result.pageCount} pages)\n`);

  console.log("1. Testing outline extraction...");
  const outline = await processor.getFormattedOutline(result.id);
  const outlineLines = outline.split('\n');
  console.log(`✓ Outline has ${outlineLines.length} lines`);
  console.log(`   First few sections:`);
  console.log(outlineLines.slice(0, 10).join('\n'));
  console.log('   ...\n');

  console.log("2. Testing section extraction...");
  try {
    const section = await processor.extractSection(result.id, "Introduction");
    console.log(`✓ Extracted "Introduction" section`);
    console.log(`   Length: ${section.length} characters`);
    console.log(`   Preview: ${section.substring(0, 200)}...\n`);
  } catch (error) {
    console.log(`   Note: ${error}\n`);

    console.log("   Trying first section from outline...");
    const firstSection = outlineLines[0].match(/^\s*(.+?)(\s+\(Page \d+\))?$/)?.[1];
    if (firstSection) {
      const section = await processor.extractSection(result.id, firstSection);
      console.log(`✓ Extracted "${firstSection}" section`);
      console.log(`   Length: ${section.length} characters`);
      console.log(`   Preview: ${section.substring(0, 200)}...\n`);
    }
  }

  console.log("3. Testing search with section grouping...");
  const searchResults = await processor.searchPDF(result.id, "PDF", false, false, 5);
  console.log(`✓ Found ${searchResults.length} sections with matches:`);
  for (const result of searchResults) {
    console.log(`   - ${result.section}: ${result.matches.length} matches`);
    if (result.matches.length > 0) {
      console.log(`     Example: "${result.matches[0].context.substring(0, 80)}..."`);
    }
  }
  console.log();

  console.log("4. Testing fuzzy section matching...");
  try {
    const section = await processor.extractSection(result.id, "scope");
    console.log(`✓ Fuzzy matched "scope" to a section`);
    console.log(`   First heading: ${section.split('\n')[0]}`);
  } catch (error) {
    console.log(`   ${error}`);
  }
  console.log();

  console.log("5. Testing library listing...");
  const pdfs = await processor.listLoadedPDFs();
  console.log(`✓ Library contains ${pdfs.length} PDF(s):`);
  for (const pdf of pdfs) {
    console.log(`   - ${pdf.id} (${pdf.pageCount} pages)`);
  }
}

async function main() {
  try {
    await testMarkdownConversion();
    console.log("\n=== All Tests Completed Successfully! ===\n");
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  }
}

main();
