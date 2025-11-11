#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PDFProcessor } from "./pdf-processor.js";
import { promises as fs } from 'fs';
import path from 'path';
import { join } from 'path';

async function getVersion() {
  try {
    const packageJsonPath = join(import.meta.dir, '..', 'package.json');
    const packageContent = await Bun.file(packageJsonPath).text();
    const packageJson = JSON.parse(packageContent);
    return packageJson.version;
  } catch {
    return '0.1.0';
  }
}

const server = new Server(
  {
    name: "pdf-splitter-mcp",
    version: await getVersion(),
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const pdfProcessor = new PDFProcessor();

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "load",
        description: "Load a PDF and convert it to structured markdown using the document's outline. Returns filename-based ID and table of contents.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the PDF file or URL (http/https)",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "section",
        description: "Extract a specific section by title (case-insensitive fuzzy match). Returns the section with all its content as markdown.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Filename-based ID of the loaded PDF",
            },
            title: {
              type: "string",
              description: "Section title to extract (fuzzy matched against outline headings)",
            },
          },
          required: ["id", "title"],
        },
      },
      {
        name: "search",
        description: "Search for text across the entire document. Results are grouped by section with configurable limits and context.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Filename-based ID of the loaded PDF",
            },
            query: {
              type: "string",
              description: "Text to search for",
            },
            caseSensitive: {
              type: "boolean",
              description: "Whether the search should be case sensitive",
              default: false,
            },
            regex: {
              type: "boolean",
              description: "Whether to treat the query as a regular expression",
              default: false,
            },
            maxResults: {
              type: "number",
              description: "Maximum number of matches to return (default: unlimited)",
            },
            contextChars: {
              type: "number",
              description: "Number of characters to include before and after each match for context (default: 50)",
              default: 50,
            },
          },
          required: ["id", "query"],
        },
      },
      {
        name: "outline",
        description: "Get the document's table of contents with section titles",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Filename-based ID of the loaded PDF",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "info",
        description: "Get metadata and information about a loaded PDF",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Filename-based ID of the loaded PDF",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "library",
        description: "List all currently loaded PDFs in your library",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "unload",
        description: "Unload a PDF from memory",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Filename-based ID of the loaded PDF",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "images",
        description: "List all images in the PDF with their metadata (page, dimensions, format)",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Filename-based ID of the loaded PDF",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "extract_images",
        description: "Extract images from the PDF as base64-encoded data",
        inputSchema: {
          type: "object",
          properties: {
            pdfId: {
              type: "string",
              description: "Filename-based ID of the loaded PDF (e.g., 'document.pdf' or 'folder/document.pdf')",
            },
            pageNumbers: {
              type: "array",
              items: { type: "number" },
              description: "Optional array of page numbers to extract images from. If not provided, extracts from all pages",
            },
            dpi: {
              type: "number",
              description: "DPI for rendering pages as images (default: 96). Set to 0 to only extract embedded images",
              default: 96,
            },
            outputPath: {
              type: "string",
              description: "Optional path pattern to save images. Use {page} for page number and {index} for image index. Example: /path/to/images/page_{page}_img_{index}.png",
            },
          },
          required: ["pdfId"],
        },
      },
      {
        name: "extract_image",
        description: "Extract a specific image from the PDF",
        inputSchema: {
          type: "object",
          properties: {
            pdfId: {
              type: "string",
              description: "Filename-based ID of the loaded PDF (e.g., 'document.pdf' or 'folder/document.pdf')",
            },
            pageNumber: {
              type: "number",
              description: "Page number containing the image (1-indexed)",
            },
            imageIndex: {
              type: "number",
              description: "Index of the image on the page (0-indexed)",
            },
            dpi: {
              type: "number",
              description: "DPI for rendering if image not found (default: 96)",
              default: 96,
            },
            outputPath: {
              type: "string",
              description: "Optional path to save the image. Example: /path/to/image.png",
            },
          },
          required: ["pdfId", "pageNumber", "imageIndex"],
        },
      },
      {
        name: "render_page",
        description: "Render a PDF page as an image (useful for complex layouts, diagrams, or OCR)",
        inputSchema: {
          type: "object",
          properties: {
            pdfId: {
              type: "string",
              description: "Filename-based ID of the loaded PDF (e.g., 'document.pdf' or 'folder/document.pdf')",
            },
            pageNumber: {
              type: "number",
              description: "Page number to render (1-indexed)",
            },
            dpi: {
              type: "number",
              description: "DPI for rendering (default: 96, recommended: 150-300 for OCR)",
              default: 96,
            },
            format: {
              type: "string",
              enum: ["png", "jpeg"],
              description: "Output image format (default: png)",
              default: "png",
            },
            outputPath: {
              type: "string",
              description: "Optional path to save the image. Example: /path/to/page.png",
            },
          },
          required: ["pdfId", "pageNumber"],
        },
      },
      {
        name: "render_pages",
        description: "Render multiple PDF pages as images",
        inputSchema: {
          type: "object",
          properties: {
            pdfId: {
              type: "string",
              description: "Filename-based ID of the loaded PDF (e.g., 'document.pdf' or 'folder/document.pdf')",
            },
            pageNumbers: {
              type: "array",
              items: { type: "number" },
              description: "Array of page numbers to render. If not provided, renders all pages",
            },
            dpi: {
              type: "number",
              description: "DPI for rendering (default: 96)",
              default: 96,
            },
            format: {
              type: "string",
              enum: ["png", "jpeg"],
              description: "Output image format (default: png)",
              default: "png",
            },
            outputPath: {
              type: "string",
              description: "Optional path pattern to save images. Use {page} for page number. Example: /path/to/images/page_{page}.png",
            },
          },
          required: ["pdfId"],
        },
      },
    ],
  };
});

async function saveImageToFile(base64Data: string, filePath: string): Promise<void> {
  const buffer = Buffer.from(base64Data, 'base64');
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(filePath, buffer);
}

function expandPathPattern(pattern: string, replacements: Record<string, number>): string {
  let expanded = pattern;
  for (const [key, value] of Object.entries(replacements)) {
    expanded = expanded.replace(new RegExp(`\\{${key}\\}`, 'g'), value.toString());
  }
  return expanded;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "load": {
        const { path } = args as { path: string };
        const result = await pdfProcessor.loadPDF(path);
        const outline = await pdfProcessor.getFormattedOutline(result.id);

        let responseText = `PDF loaded and converted to markdown.\nID: ${result.id}\nPages: ${result.pageCount}\n\nUse section('${result.id}', 'title') to extract specific sections.`;

        if (outline && outline !== "No outline/TOC found in this PDF.") {
          responseText += `\n\nTable of Contents:\n${outline}`;
        }

        return {
          content: [
            {
              type: "text",
              text: responseText,
            },
          ],
        };
      }

      case "section": {
        const { id, title } = args as {
          id: string;
          title: string;
        };
        const content = await pdfProcessor.extractSection(id, title);
        return {
          content: [
            {
              type: "text",
              text: content,
            },
          ],
        };
      }

      case "search": {
        const { id, query, caseSensitive = false, regex = false, maxResults, contextChars = 50 } = args as {
          id: string;
          query: string;
          caseSensitive?: boolean;
          regex?: boolean;
          maxResults?: number;
          contextChars?: number;
        };
        const results = await pdfProcessor.searchPDF(
          id,
          query,
          caseSensitive,
          regex,
          maxResults,
          contextChars
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case "outline": {
        const { id } = args as { id: string };
        const outline = await pdfProcessor.getFormattedOutline(id);
        return {
          content: [
            {
              type: "text",
              text: outline,
            },
          ],
        };
      }

      case "info": {
        const { id } = args as { id: string };
        const info = await pdfProcessor.getPDFInfo(id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(info, null, 2),
            },
          ],
        };
      }

      case "library": {
        const pdfs = await pdfProcessor.listLoadedPDFs();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(pdfs, null, 2),
            },
          ],
        };
      }

      case "unload": {
        const { id } = args as { id: string };
        const removed = await pdfProcessor.unloadPDF(id);
        if (removed) {
          return {
            content: [
              {
                type: "text",
                text: `PDF ${id} unloaded successfully.`,
              },
            ],
          };
        } else {
          throw new Error(`PDF ${id} not found.`);
        }
      }

      case "images": {
        const { id } = args as { id: string };
        const images = await pdfProcessor.listImages(id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(images.map(img => ({
                page: img.page,
                index: img.index,
                width: img.width,
                height: img.height,
                format: img.format,
              })), null, 2),
            },
          ],
        };
      }

      case "extract_images": {
        const { pdfId, pageNumbers, dpi = 96, outputPath } = args as { 
          pdfId: string; 
          pageNumbers?: number[]; 
          dpi?: number;
          outputPath?: string;
        };
        const images = await pdfProcessor.extractImages(pdfId, pageNumbers, dpi);
        
        if (outputPath) {
          for (const image of images) {
            const filePath = expandPathPattern(outputPath, { 
              page: image.page, 
              index: image.index 
            });
            await saveImageToFile(image.base64, filePath);
          }
          return {
            content: [
              {
                type: "text",
                text: `Saved ${images.length} images. First image saved to: ${expandPathPattern(outputPath, { page: images[0]?.page || 1, index: images[0]?.index || 0 })}`,
              },
            ],
          };
        }
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(images, null, 2),
            },
          ],
        };
      }

      case "extract_image": {
        const { pdfId, pageNumber, imageIndex, dpi = 96, outputPath } = args as {
          pdfId: string;
          pageNumber: number;
          imageIndex: number;
          dpi?: number;
          outputPath?: string;
        };
        const image = await pdfProcessor.extractImage(pdfId, pageNumber, imageIndex, dpi);
        if (!image) {
          throw new Error(`Image not found on page ${pageNumber} at index ${imageIndex}`);
        }
        
        if (outputPath) {
          await saveImageToFile(image.base64, outputPath);
          return {
            content: [
              {
                type: "text",
                text: `Image saved to: ${outputPath}`,
              },
            ],
          };
        }
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(image, null, 2),
            },
          ],
        };
      }

      case "render_page": {
        const { pdfId, pageNumber, dpi = 96, format = 'png', outputPath } = args as {
          pdfId: string;
          pageNumber: number;
          dpi?: number;
          format?: 'png' | 'jpeg';
          outputPath?: string;
        };
        const renderedPage = await pdfProcessor.renderPage(pdfId, pageNumber, dpi, format);
        
        if (outputPath) {
          await saveImageToFile(renderedPage.base64, outputPath);
          return {
            content: [
              {
                type: "text",
                text: `Page ${pageNumber} rendered and saved to: ${outputPath}`,
              },
            ],
          };
        }
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(renderedPage, null, 2),
            },
          ],
        };
      }

      case "render_pages": {
        const { pdfId, pageNumbers, dpi = 96, format = 'png', outputPath } = args as {
          pdfId: string;
          pageNumbers?: number[];
          dpi?: number;
          format?: 'png' | 'jpeg';
          outputPath?: string;
        };
        const renderedPages = await pdfProcessor.renderPages(pdfId, pageNumbers, dpi, format);
        
        if (outputPath) {
          for (const page of renderedPages) {
            const filePath = expandPathPattern(outputPath, { page: page.page });
            await saveImageToFile(page.base64, filePath);
          }
          return {
            content: [
              {
                type: "text",
                text: `Rendered ${renderedPages.length} pages. First page saved to: ${expandPathPattern(outputPath, { page: renderedPages[0]?.page || 1 })}`,
              },
            ],
          };
        }
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(renderedPages, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
});

async function main() {
  await pdfProcessor.restoreCache();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("PDF Splitter MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});