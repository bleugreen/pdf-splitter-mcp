import { readFile, writeFile, mkdir } from "fs/promises";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import { createCanvas } from "canvas";
import path from "path";
import os from "os";
import { existsSync } from "fs";

interface LoadedPDF {
  id: string;
  path: string;
  pageCount: number;
  pages: string[];
  metadata: any;
  outline?: OutlineItem[];
}

interface SearchResult {
  page: number;
  matches: Array<{
    text: string;
    context: string;
  }>;
}

interface OutlineItem {
  title: string;
  page?: number;
  level: number;
  children?: OutlineItem[];
}

interface ImageInfo {
  page: number;
  index: number;
  width: number;
  height: number;
  format?: string;
  data?: Uint8Array;
}

interface ExtractedImage {
  page: number;
  index: number;
  width: number;
  height: number;
  format: string;
  base64: string;
}

interface RenderedPage {
  page: number;
  width: number;
  height: number;
  format: string;
  base64: string;
  dpi: number;
}

export class PDFProcessor {
  private readonly loadedPDFs: Map<string, LoadedPDF> = new Map();
  private readonly cacheDir: string;
  private readonly cacheFile: string;

  constructor() {
    this.cacheDir = path.join(os.homedir(), '.pdf-splitter-mcp');
    this.cacheFile = path.join(this.cacheDir, 'cache.json');
  }

  private generateUniqueId(filePath: string): string {
    let normalizedPath: string;
    let parts: string[];

    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      try {
        const url = new URL(filePath);
        const urlPath = url.pathname;
        parts = urlPath.split('/').filter(p => p.length > 0);
        normalizedPath = filePath;
      } catch {
        normalizedPath = filePath;
        parts = filePath.split('/').filter(p => p.length > 0);
      }
    } else {
      normalizedPath = path.normalize(filePath);
      parts = normalizedPath.split(path.sep).filter(p => p.length > 0);
    }

    if (parts.length === 0) {
      return "unknown.pdf";
    }

    const existingPaths = new Map<string, string>();
    for (const [id, pdf] of this.loadedPDFs.entries()) {
      const pdfNormalizedPath = pdf.path.startsWith('http://') || pdf.path.startsWith('https://')
        ? pdf.path
        : path.normalize(pdf.path);
      existingPaths.set(id, pdfNormalizedPath);
    }

    if (existingPaths.get(parts[parts.length - 1]) === normalizedPath) {
      return parts[parts.length - 1];
    }

    const separator = filePath.startsWith('http://') || filePath.startsWith('https://') ? '/' : path.sep;

    for (let i = 1; i <= parts.length; i++) {
      const candidateId = parts.slice(-i).join(separator);

      const existingPath = existingPaths.get(candidateId);
      if (!existingPath) {
        return candidateId;
      }

      if (existingPath === normalizedPath) {
        return candidateId;
      }
    }

    return parts.join(separator);
  }

  private async saveCache(): Promise<void> {
    try {
      if (!existsSync(this.cacheDir)) {
        await mkdir(this.cacheDir, { recursive: true });
      }

      const cacheData = Array.from(this.loadedPDFs.values()).map(pdf => ({
        id: pdf.id,
        path: pdf.path,
      }));

      await writeFile(this.cacheFile, JSON.stringify(cacheData, null, 2), 'utf-8');
    } catch (error) {
      console.warn('Failed to save cache:', error);
    }
  }

  async restoreCache(): Promise<void> {
    try {
      if (!existsSync(this.cacheFile)) {
        return;
      }

      const cacheContent = await readFile(this.cacheFile, 'utf-8');
      const cacheData = JSON.parse(cacheContent) as Array<{ id: string; path: string }>;

      for (const item of cacheData) {
        try {
          await this.loadPDF(item.path);
          console.error(`Restored PDF from cache: ${item.id}`);
        } catch (error) {
          console.warn(`Failed to restore PDF ${item.id}:`, error);
        }
      }
    } catch (error) {
      console.warn('Failed to restore cache:', error);
    }
  }

  async loadPDF(filePath: string): Promise<{ id: string; pageCount: number }> {
    try {
      let dataBuffer: Buffer;

      // Check if the path is a URL
      if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        // Fetch the PDF from URL
        const response = await fetch(filePath);
        if (!response.ok) {
          throw new Error(`Failed to fetch PDF from URL: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        dataBuffer = Buffer.from(arrayBuffer);
      } else {
        // Read from local file system
        dataBuffer = await readFile(filePath);
      }
      
      // Use pdfjs-dist for page extraction
      // Convert Buffer to Uint8Array for pdfjs-dist
      const uint8Array = new Uint8Array(dataBuffer);
      
      const doc = await pdfjsLib.getDocument({
        data: uint8Array,
        useWorkerFetch: false,
        isEvalSupported: false,
        useSystemFonts: true,
      }).promise;
      const numPages = doc.numPages;
      
      // Extract metadata
      let metadata: any = null;
      try {
        const metaData = await doc.getMetadata();
        metadata = metaData ? metaData.info : null;
      } catch (error) {
        console.warn("Could not extract metadata:", error);
      }
      
      // Extract outline
      let outline: OutlineItem[] | undefined;
      try {
        const rawOutline = await doc.getOutline();
        if (rawOutline && rawOutline.length > 0) {
          outline = await this.processOutline(rawOutline, doc, 0);
        }
      } catch (outlineError) {
        // Some PDFs might not have outlines
        console.warn("Could not extract outline:", outlineError);
      }
      
      // Extract text from each page individually
      const pages: string[] = [];
      for (let i = 1; i <= numPages; i++) {
        try {
          const page = await doc.getPage(i);
          const textContent = await page.getTextContent();
          
          let lastY: number | null = null;
          let pageText = '';
          
          // Process text items and maintain line breaks
          for (const item of textContent.items) {
            if ('str' in item) {
              const textItem = item as any; // TextItem type
              if (lastY !== null && Math.abs(lastY - textItem.transform[5]) > 1) {
                // New line detected
                pageText += '\n';
              }
              pageText += textItem.str;
              lastY = textItem.transform[5];
            }
          }
          
          pages.push(pageText);
        } catch (pageError) {
          console.warn(`Could not extract text from page ${i}:`, pageError);
          pages.push(''); // Add empty string for failed pages
        }
      }
      
      doc.destroy();

      const id = this.generateUniqueId(filePath);

      this.loadedPDFs.set(id, {
        id,
        path: filePath,
        pageCount: numPages,
        pages,
        metadata,
        outline,
      });

      await this.saveCache();

      return { id, pageCount: numPages };
    } catch (error) {
      throw new Error(`Failed to load PDF: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async processOutline(outline: any[], doc: PDFDocumentProxy, level: number): Promise<OutlineItem[]> {
    const items: OutlineItem[] = [];
    
    for (const item of outline) {
      const outlineItem: OutlineItem = {
        title: item.title,
        level,
      };
      
      // Try to get the page number from the destination
      if (item.dest) {
        try {
          const dest = typeof item.dest === 'string' 
            ? await doc.getDestination(item.dest)
            : item.dest;
          
          if (dest?.[0]) {
            const pageRef = dest[0];
            const pageIndex = await this.getPageIndex(doc, pageRef);
            if (pageIndex !== null) {
              outlineItem.page = pageIndex + 1; // Convert to 1-based
            }
          }
        } catch {
          console.warn("Could not resolve destination for:", item.title);
        }
      }
      
      // Process children recursively
      if (item.items && item.items.length > 0) {
        outlineItem.children = await this.processOutline(item.items, doc, level + 1);
      }
      
      items.push(outlineItem);
    }
    
    return items;
  }

  private async getPageIndex(doc: PDFDocumentProxy, pageRef: any): Promise<number | null> {
    try {
      if (pageRef && typeof pageRef === 'object' && pageRef.num !== undefined) {
        // pageRef is a reference object, we need to find its index
        for (let i = 0; i < doc.numPages; i++) {
          const page = await doc.getPage(i + 1);
          const pageRefObj = (page as any).ref;
          if (pageRefObj && pageRefObj.num === pageRef.num && pageRefObj.gen === pageRef.gen) {
            return i;
          }
        }
      }
    } catch (error) {
      console.warn("Error getting page index:", error);
    }
    return null;
  }

  async extractPage(pdfId: string, pageNumber: number): Promise<string> {
    const pdf = this.loadedPDFs.get(pdfId);
    if (!pdf) {
      throw new Error("PDF not found. Please load it first.");
    }
    
    if (pageNumber < 1 || pageNumber > pdf.pageCount) {
      throw new Error(`Invalid page number. PDF has ${pdf.pageCount} pages.`);
    }
    
    return pdf.pages[pageNumber - 1] || "";
  }

  async extractRange(
    pdfId: string,
    startPage: number,
    endPage: number
  ): Promise<string> {
    const pdf = this.loadedPDFs.get(pdfId);
    if (!pdf) {
      throw new Error("PDF not found. Please load it first.");
    }
    
    if (startPage < 1 || endPage > pdf.pageCount || startPage > endPage) {
      throw new Error(`Invalid page range. PDF has ${pdf.pageCount} pages.`);
    }
    
    const pages: string[] = [];
    for (let i = startPage; i <= endPage; i++) {
      pages.push(`--- Page ${i} ---\n${pdf.pages[i - 1] || ""}`);
    }
    
    return pages.join("\n\n");
  }

  async searchPDF(
    pdfId: string,
    query: string,
    caseSensitive: boolean = false,
    regex: boolean = false,
    maxResults?: number,
    contextChars: number = 50
  ): Promise<SearchResult[]> {
    const pdf = this.loadedPDFs.get(pdfId);
    if (!pdf) {
      throw new Error("PDF not found. Please load it first.");
    }

    const results: SearchResult[] = [];
    let totalMatches = 0;

    if (regex) {
      // Regex search
      let regexPattern: RegExp;
      try {
        regexPattern = new RegExp(query, caseSensitive ? 'g' : 'gi');
      } catch (error) {
        throw new Error(`Invalid regular expression: ${query}`);
      }

      for (let index = 0; index < pdf.pages.length; index++) {
        const pageText = pdf.pages[index];
        const matches: Array<{ text: string; context: string }> = [];
        let match: RegExpExecArray | null;

        // Reset lastIndex for each page
        regexPattern.lastIndex = 0;

        while ((match = regexPattern.exec(pageText)) !== null) {
          if (maxResults && totalMatches >= maxResults) {
            break;
          }

          const position = match.index;
          const matchedText = match[0];
          const contextStart = Math.max(0, position - contextChars);
          const contextEnd = Math.min(pageText.length, position + matchedText.length + contextChars);
          const context = pageText.substring(contextStart, contextEnd);

          matches.push({
            text: matchedText,
            context: context.trim(),
          });

          totalMatches++;

          // Prevent infinite loop for zero-width matches
          if (match.index === regexPattern.lastIndex) {
            regexPattern.lastIndex++;
          }
        }

        if (matches.length > 0) {
          results.push({
            page: index + 1,
            matches,
          });
        }

        if (maxResults && totalMatches >= maxResults) {
          break;
        }
      }
    } else {
      // Plain text search
      const searchQuery = caseSensitive ? query : query.toLowerCase();

      for (let index = 0; index < pdf.pages.length; index++) {
        const pageText = pdf.pages[index];
        const searchText = caseSensitive ? pageText : pageText.toLowerCase();
        const matches: Array<{ text: string; context: string }> = [];

        let position = 0;
        while ((position = searchText.indexOf(searchQuery, position)) !== -1) {
          if (maxResults && totalMatches >= maxResults) {
            break;
          }

          const contextStart = Math.max(0, position - contextChars);
          const contextEnd = Math.min(pageText.length, position + searchQuery.length + contextChars);
          const context = pageText.substring(contextStart, contextEnd);

          matches.push({
            text: pageText.substring(position, position + query.length),
            context: context.trim(),
          });

          totalMatches++;
          position += searchQuery.length;
        }

        if (matches.length > 0) {
          results.push({
            page: index + 1,
            matches,
          });
        }

        if (maxResults && totalMatches >= maxResults) {
          break;
        }
      }
    }

    return results;
  }

  async getPDFInfo(pdfId: string): Promise<any> {
    const pdf = this.loadedPDFs.get(pdfId);
    if (!pdf) {
      throw new Error("PDF not found. Please load it first.");
    }
    
    return {
      id: pdf.id,
      path: pdf.path,
      pageCount: pdf.pageCount,
      metadata: pdf.metadata,
    };
  }

  async listLoadedPDFs(): Promise<Array<{ id: string; path: string; pageCount: number }>> {
    return Array.from(this.loadedPDFs.values()).map((pdf) => ({
      id: pdf.id,
      path: pdf.path,
      pageCount: pdf.pageCount,
    }));
  }

  async unloadPDF(pdfId: string): Promise<boolean> {
    const removed = this.loadedPDFs.delete(pdfId);
    if (removed) {
      await this.saveCache();
    }
    return removed;
  }

  async extractOutline(pdfId: string): Promise<OutlineItem[] | null> {
    const pdf = this.loadedPDFs.get(pdfId);
    if (!pdf) {
      throw new Error("PDF not found. Please load it first.");
    }
    
    if (!pdf.outline || pdf.outline.length === 0) {
      return null;
    }
    
    return pdf.outline;
  }

  private formatOutlineAsText(items: OutlineItem[], indent: string = ""): string {
    let result = "";
    
    for (const item of items) {
      const pageInfo = item.page ? ` (Page ${item.page})` : "";
      result += `${indent}${item.title}${pageInfo}\n`;
      
      if (item.children && item.children.length > 0) {
        result += this.formatOutlineAsText(item.children, indent + "  ");
      }
    }
    
    return result;
  }

  async getFormattedOutline(pdfId: string): Promise<string> {
    const outline = await this.extractOutline(pdfId);
    
    if (!outline) {
      return "No outline/TOC found in this PDF.";
    }
    
    return this.formatOutlineAsText(outline);
  }

  async listImages(pdfId: string): Promise<ImageInfo[]> {
    const pdf = this.loadedPDFs.get(pdfId);
    if (!pdf) {
      throw new Error("PDF not found. Please load it first.");
    }

    const images: ImageInfo[] = [];

    // Reload the document to access images
    let dataBuffer: Buffer;
    if (pdf.path.startsWith('http://') || pdf.path.startsWith('https://')) {
      const response = await fetch(pdf.path);
      const arrayBuffer = await response.arrayBuffer();
      dataBuffer = Buffer.from(arrayBuffer);
    } else {
      dataBuffer = await readFile(pdf.path);
    }

    const uint8Array = new Uint8Array(dataBuffer);
    const doc = await pdfjsLib.getDocument({
      data: uint8Array,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;

    try {
      for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        const page = await doc.getPage(pageNum);
        const pageImages = await this.listImagesFromPage(page, pageNum);
        images.push(...pageImages);
      }
    } finally {
      doc.destroy();
    }

    return images;
  }

  private async listImagesFromPage(page: PDFPageProxy, pageNum: number): Promise<ImageInfo[]> {
    const images: ImageInfo[] = [];
    const ops = await page.getOperatorList();

    let imageIndex = 0;

    // Only list embedded images metadata, don't extract data
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];

      // OPS.paintImageXObject = 85, OPS.paintJpegXObject = 82, OPS.paintImageMaskXObject = 83
      if (fn === 85 || fn === 82 || fn === 83) {
        const imageName = args[0];

        try {
          const imageObj = await page.objs.get(imageName);
          if (imageObj && imageObj.width && imageObj.height) {
            let format = 'unknown';

            // Determine format without extracting data
            if (imageObj.data && imageObj.data.length > 0) {
              const data = new Uint8Array(imageObj.data);

              // Check for JPEG
              if (data[0] === 0xFF && data[1] === 0xD8) {
                format = 'jpeg';
              }
              // Check for PNG
              else if (data[0] === 0x89 && data[1] === 0x50) {
                format = 'png';
              } else {
                format = 'raw';
              }
            }

            images.push({
              page: pageNum,
              index: imageIndex++,
              width: imageObj.width,
              height: imageObj.height,
              format: format,
            });
          }
        } catch (error) {
          console.warn(`Failed to get image metadata ${imageName} on page ${pageNum}:`, error);
        }
      }
    }

    return images;
  }

  async extractImages(pdfId: string, pageNumbers?: number[], dpi: number = 96): Promise<ExtractedImage[]> {
    const pdf = this.loadedPDFs.get(pdfId);
    if (!pdf) {
      throw new Error("PDF not found. Please load it first.");
    }

    const images: ExtractedImage[] = [];
    
    // Reload the document to access images
    let dataBuffer: Buffer;
    if (pdf.path.startsWith('http://') || pdf.path.startsWith('https://')) {
      const response = await fetch(pdf.path);
      const arrayBuffer = await response.arrayBuffer();
      dataBuffer = Buffer.from(arrayBuffer);
    } else {
      dataBuffer = await readFile(pdf.path);
    }
    
    const uint8Array = new Uint8Array(dataBuffer);
    const doc = await pdfjsLib.getDocument({
      data: uint8Array,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;

    try {
      const pagesToProcess = pageNumbers || Array.from({ length: doc.numPages }, (_, i) => i + 1);
      
      for (const pageNum of pagesToProcess) {
        if (pageNum < 1 || pageNum > doc.numPages) continue;
        
        const page = await doc.getPage(pageNum);
        const pageImages = await this.extractImagesFromPage(page, pageNum, dpi);
        
        // Convert to base64
        for (const imgInfo of pageImages) {
          if (imgInfo.data) {
            const base64 = Buffer.from(imgInfo.data).toString('base64');
            images.push({
              page: imgInfo.page,
              index: imgInfo.index,
              width: imgInfo.width,
              height: imgInfo.height,
              format: imgInfo.format ?? 'png',
              base64: base64,
            });
          }
        }
      }
    } finally {
      doc.destroy();
    }

    return images;
  }

  async extractImage(pdfId: string, pageNumber: number, imageIndex: number, dpi: number = 96): Promise<ExtractedImage | null> {
    const images = await this.extractImages(pdfId, [pageNumber], dpi);
    const image = images.find(img => img.page === pageNumber && img.index === imageIndex);
    return image || null;
  }

  private async extractImagesFromPage(page: PDFPageProxy, pageNum: number, dpi: number = 96): Promise<ImageInfo[]> {
    const images: ImageInfo[] = [];
    const ops = await page.getOperatorList();
    
    // Calculate scale factor from PDF points (72 DPI) to target DPI
    const scale = dpi / 72;
    
    let imageIndex = 0;
    
    // First, try to extract embedded images
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      
      // OPS.paintImageXObject = 85, OPS.paintJpegXObject = 82, OPS.paintImageMaskXObject = 83
      if (fn === 85 || fn === 82 || fn === 83) {
        const imageName = args[0];
        
        try {
          const imageObj = await page.objs.get(imageName);
          if (imageObj) {
            let format = 'unknown';
            let imageData: Uint8Array | undefined;
            
            // Check if it's a native image format
            if (imageObj.data && imageObj.data.length > 0) {
              const data = new Uint8Array(imageObj.data);
              
              // Check for JPEG
              if (data[0] === 0xFF && data[1] === 0xD8) {
                format = 'jpeg';
                imageData = data;
              }
              // Check for PNG
              else if (data[0] === 0x89 && data[1] === 0x50) {
                format = 'png';
                imageData = data;
              }
              // Otherwise it's raw image data that needs conversion
              else if (imageObj.width && imageObj.height) {
                format = 'png';
                imageData = await this.convertRawImageToPNG(imageObj);
              }
            }
            
            if (imageData) {
              images.push({
                page: pageNum,
                index: imageIndex++,
                width: imageObj.width ?? 0,
                height: imageObj.height ?? 0,
                format: format,
                data: imageData,
              });
            }
          }
        } catch (error) {
          console.warn(`Failed to extract image ${imageName} on page ${pageNum}:`, error);
        }
      }
    }
    
    // If no embedded images found, optionally render the whole page as an image
    if (images.length === 0 && dpi > 0) {
      try {
        const viewport = page.getViewport({ scale: scale });
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d');
        
        await page.render({
          canvasContext: context as any,
          viewport: viewport,
        }).promise;
        
        const pngData = canvas.toBuffer('image/png');
        
        images.push({
          page: pageNum,
          index: 0,
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
          format: 'png',
          data: new Uint8Array(pngData),
        });
      } catch (renderError) {
        console.warn(`Failed to render page ${pageNum} as image:`, renderError);
      }
    }
    
    return images;
  }

  private async convertRawImageToPNG(imageObj: any): Promise<Uint8Array> {
    const width = imageObj.width;
    const height = imageObj.height;
    const data = imageObj.data;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // Create ImageData from the raw data
    const imageData = ctx.createImageData(width, height);
    
    // Handle different color spaces
    if (imageObj.kind === 1) { // RGB/RGBA
      for (let i = 0; i < data.length; i++) {
        imageData.data[i] = data[i];
      }
    } else if (imageObj.kind === 2) { // Grayscale
      for (let i = 0, j = 0; i < data.length; i++, j += 4) {
        imageData.data[j] = data[i];     // R
        imageData.data[j + 1] = data[i]; // G
        imageData.data[j + 2] = data[i]; // B
        imageData.data[j + 3] = 255;     // A
      }
    }
    
    ctx.putImageData(imageData, 0, 0);
    
    return new Uint8Array(canvas.toBuffer('image/png'));
  }

  async renderPage(pdfId: string, pageNumber: number, dpi: number = 96, format: 'png' | 'jpeg' = 'png'): Promise<RenderedPage> {
    const pdf = this.loadedPDFs.get(pdfId);
    if (!pdf) {
      throw new Error("PDF not found. Please load it first.");
    }

    if (pageNumber < 1 || pageNumber > pdf.pageCount) {
      throw new Error(`Invalid page number. PDF has ${pdf.pageCount} pages.`);
    }

    // Reload the document for rendering
    let dataBuffer: Buffer;
    if (pdf.path.startsWith('http://') || pdf.path.startsWith('https://')) {
      const response = await fetch(pdf.path);
      const arrayBuffer = await response.arrayBuffer();
      dataBuffer = Buffer.from(arrayBuffer);
    } else {
      dataBuffer = await readFile(pdf.path);
    }
    
    const uint8Array = new Uint8Array(dataBuffer);
    const doc = await pdfjsLib.getDocument({
      data: uint8Array,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;

    try {
      const page = await doc.getPage(pageNumber);
      
      // Calculate scale from PDF points (72 DPI) to target DPI
      const scale = dpi / 72;
      const viewport = page.getViewport({ scale });
      
      // Try using @napi-rs/canvas first
      let canvas: any;
      let ctx: any;
      
      try {
        // Try @napi-rs/canvas which has better compatibility
        const { createCanvas: createNapiCanvas } = await import('@napi-rs/canvas');
        canvas = createNapiCanvas(Math.round(viewport.width), Math.round(viewport.height));
        ctx = canvas.getContext('2d');
      } catch {
        // Fallback to node-canvas
        canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
        ctx = canvas.getContext('2d');
      }
      
      // Render the page
      await page.render({
        canvasContext: ctx,
        viewport: viewport,
      }).promise;
      
      // Convert to buffer
      let imageBuffer: Buffer;
      if (format === 'jpeg') {
        imageBuffer = canvas.toBuffer('image/jpeg', { quality: 0.95 });
      } else {
        imageBuffer = canvas.toBuffer('image/png');
      }
      
      return {
        page: pageNumber,
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
        format: format,
        base64: imageBuffer.toString('base64'),
        dpi: dpi,
      };
    } finally {
      doc.destroy();
    }
  }

  async renderPages(
    pdfId: string,
    pageNumbers?: number[],
    dpi: number = 96,
    format: 'png' | 'jpeg' = 'png'
  ): Promise<RenderedPage[]> {
    const pdf = this.loadedPDFs.get(pdfId);
    if (!pdf) {
      throw new Error("PDF not found. Please load it first.");
    }

    const pages = pageNumbers || Array.from({ length: pdf.pageCount }, (_, i) => i + 1);
    const renderedPages: RenderedPage[] = [];

    // Load the document once for all pages
    let dataBuffer: Buffer;
    if (pdf.path.startsWith('http://') || pdf.path.startsWith('https://')) {
      const response = await fetch(pdf.path);
      const arrayBuffer = await response.arrayBuffer();
      dataBuffer = Buffer.from(arrayBuffer);
    } else {
      dataBuffer = await readFile(pdf.path);
    }

    const uint8Array = new Uint8Array(dataBuffer);
    const doc = await pdfjsLib.getDocument({
      data: uint8Array,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;

    try {
      for (const pageNum of pages) {
        if (pageNum < 1 || pageNum > pdf.pageCount) {
          continue;
        }

        try {
          const page = await doc.getPage(pageNum);

          const scale = dpi / 72;
          const viewport = page.getViewport({ scale });

          let canvas: any;
          let ctx: any;

          try {
            const { createCanvas: createNapiCanvas } = await import('@napi-rs/canvas');
            canvas = createNapiCanvas(Math.round(viewport.width), Math.round(viewport.height));
            ctx = canvas.getContext('2d');
          } catch {
            canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
            ctx = canvas.getContext('2d');
          }

          await page.render({
            canvasContext: ctx,
            viewport: viewport,
          }).promise;

          let imageBuffer: Buffer;
          if (format === 'jpeg') {
            imageBuffer = canvas.toBuffer('image/jpeg', { quality: 0.95 });
          } else {
            imageBuffer = canvas.toBuffer('image/png');
          }

          renderedPages.push({
            page: pageNum,
            width: Math.round(viewport.width),
            height: Math.round(viewport.height),
            format: format,
            base64: imageBuffer.toString('base64'),
            dpi: dpi,
          });
        } catch (error) {
          console.warn(`Failed to render page ${pageNum}:`, error);
        }
      }
    } finally {
      doc.destroy();
    }

    return renderedPages;
  }
}