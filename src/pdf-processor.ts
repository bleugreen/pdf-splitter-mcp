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
  markdown: string;
  metadata: any;
  outline?: OutlineItem[];
}

interface SearchResult {
  page: number;
  section?: string;
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

interface SectionPage {
  page: number;
  totalPages: number;
  content: string;
  section: string;
}

export class PDFProcessor {
  private readonly loadedPDFs: Map<string, LoadedPDF> = new Map();
  private readonly cacheDir: string;
  private readonly cacheFile: string;
  private readonly fetchTimeout: number = 60000;

  constructor() {
    this.cacheDir = path.join(os.homedir(), '.pdf-splitter-mcp');
    this.cacheFile = path.join(this.cacheDir, 'cache.json');
  }

  private async fetchWithTimeout(url: string, timeoutMs?: number): Promise<Response> {
    const timeout = timeoutMs || this.fetchTimeout;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      console.error(`Fetching PDF from URL (timeout: ${timeout}ms)...`);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Fetch timeout after ${timeout}ms. The PDF URL may be slow or unreachable.`);
      }
      throw error;
    }
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
        // Fetch the PDF from URL with timeout
        const response = await this.fetchWithTimeout(filePath);
        if (!response.ok) {
          throw new Error(`Failed to fetch PDF from URL: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        dataBuffer = Buffer.from(arrayBuffer);
        console.error(`✓ PDF downloaded (${(dataBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
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

      const markdown = this.convertToMarkdown(pages, outline);

      const id = this.generateUniqueId(filePath);

      this.loadedPDFs.set(id, {
        id,
        path: filePath,
        pageCount: numPages,
        markdown,
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

  private convertToMarkdown(pages: string[], outline?: OutlineItem[]): string {
    if (!outline || outline.length === 0) {
      return pages.join('\n\n');
    }

    interface FlatSection {
      title: string;
      level: number;
      startPage: number;
      endPage: number;
    }

    const flattenOutline = (items: OutlineItem[], parentLevel: number = 0): FlatSection[] => {
      const sections: FlatSection[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.page) {
          const nextItem = items[i + 1];
          const endPage = nextItem?.page ? nextItem.page - 1 : pages.length;

          sections.push({
            title: item.title,
            level: item.level,
            startPage: item.page,
            endPage: endPage,
          });
        }

        if (item.children && item.children.length > 0) {
          sections.push(...flattenOutline(item.children, item.level));
        }
      }

      return sections;
    };

    const sections = flattenOutline(outline);
    sections.sort((a, b) => a.startPage - b.startPage);

    let markdown = '';
    let lastEndPage = 0;

    for (const section of sections) {
      if (section.startPage > lastEndPage + 1) {
        for (let p = lastEndPage + 1; p < section.startPage; p++) {
          if (pages[p - 1]?.trim()) {
            markdown += pages[p - 1] + '\n\n';
          }
        }
      }

      const headingPrefix = '#'.repeat(section.level + 1);
      markdown += `${headingPrefix} ${section.title}\n\n`;

      for (let p = section.startPage; p <= section.endPage; p++) {
        if (pages[p - 1]?.trim()) {
          markdown += pages[p - 1] + '\n\n';
        }
      }

      lastEndPage = section.endPage;
    }

    if (lastEndPage < pages.length) {
      for (let p = lastEndPage + 1; p <= pages.length; p++) {
        if (pages[p - 1]?.trim()) {
          markdown += pages[p - 1] + '\n\n';
        }
      }
    }

    return markdown.trim();
  }

  async extractSection(
    pdfId: string,
    sectionTitle: string,
    page: number = 1,
    charsPerPage: number = 4000
  ): Promise<SectionPage> {
    const pdf = this.loadedPDFs.get(pdfId);
    if (!pdf) {
      throw new Error("PDF not found. Please load it first.");
    }

    const normalizedQuery = sectionTitle.toLowerCase().trim();
    const lines = pdf.markdown.split('\n');

    let sectionStart = -1;
    let sectionLevel = 0;
    let sectionEnd = lines.length;
    let matchedTitle = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#+)\s+(.+)$/);

      if (headingMatch) {
        const level = headingMatch[1].length;
        const title = headingMatch[2].toLowerCase().trim();

        if (sectionStart === -1) {
          if (title.includes(normalizedQuery) || normalizedQuery.includes(title)) {
            sectionStart = i;
            sectionLevel = level;
            matchedTitle = headingMatch[2];
          }
        } else {
          if (level <= sectionLevel) {
            sectionEnd = i;
            break;
          }
        }
      }
    }

    if (sectionStart === -1) {
      const suggestions = this.findSimilarSections(pdf.markdown, sectionTitle);
      const suggestionText = suggestions.length > 0
        ? `\n\nDid you mean one of these?\n${suggestions.map(s => `  - ${s}`).join('\n')}`
        : '';
      throw new Error(`Section "${sectionTitle}" not found in outline.${suggestionText}`);
    }

    const fullContent = lines.slice(sectionStart, sectionEnd).join('\n').trim();

    const pages = this.paginateContent(fullContent, charsPerPage);

    if (page < 1 || page > pages.length) {
      throw new Error(`Page ${page} out of range. Section has ${pages.length} page(s).`);
    }

    return {
      page,
      totalPages: pages.length,
      content: pages[page - 1],
      section: matchedTitle,
    };
  }

  private paginateContent(content: string, charsPerPage: number): string[] {
    if (content.length <= charsPerPage) {
      return [content];
    }

    const pages: string[] = [];
    const paragraphs = content.split('\n\n');

    let currentPage = '';

    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i];
      const isHeading = paragraph.match(/^#+\s/);
      const nextParagraph = paragraphs[i + 1];

      if (currentPage.length === 0) {
        currentPage = paragraph;

        if (isHeading && nextParagraph && currentPage.length + nextParagraph.length + 2 <= charsPerPage) {
          currentPage += '\n\n' + nextParagraph;
          i++;
        }
      } else if (currentPage.length + paragraph.length + 2 <= charsPerPage) {
        currentPage += '\n\n' + paragraph;

        if (isHeading && nextParagraph && currentPage.length + nextParagraph.length + 2 <= charsPerPage) {
          currentPage += '\n\n' + nextParagraph;
          i++;
        }
      } else {
        pages.push(currentPage);
        currentPage = paragraph;

        if (isHeading && nextParagraph && currentPage.length + nextParagraph.length + 2 <= charsPerPage) {
          currentPage += '\n\n' + nextParagraph;
          i++;
        }
      }
    }

    if (currentPage.length > 0) {
      pages.push(currentPage);
    }

    return pages;
  }

  private findSimilarSections(markdown: string, query: string): string[] {
    const lines = markdown.split('\n');
    const sections: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^#+\s+(.+)$/);
      if (headingMatch) {
        sections.push(headingMatch[1]);
      }
    }

    return sections.slice(0, 5);
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

    const findSectionForPosition = (position: number): string => {
      const textBeforeMatch = pdf.markdown.substring(0, position);
      const lines = textBeforeMatch.split('\n');

      for (let i = lines.length - 1; i >= 0; i--) {
        const headingMatch = lines[i].match(/^#+\s+(.+)$/);
        if (headingMatch) {
          return headingMatch[1];
        }
      }

      return 'Document Start';
    };

    const matches: Array<{ text: string; context: string; section: string }> = [];
    let totalMatches = 0;

    if (regex) {
      let regexPattern: RegExp;
      try {
        regexPattern = new RegExp(query, caseSensitive ? 'g' : 'gi');
      } catch (error) {
        throw new Error(`Invalid regular expression: ${query}`);
      }

      let match: RegExpExecArray | null;
      regexPattern.lastIndex = 0;

      while ((match = regexPattern.exec(pdf.markdown)) !== null) {
        if (maxResults && totalMatches >= maxResults) {
          break;
        }

        const position = match.index;
        const matchedText = match[0];
        const contextStart = Math.max(0, position - contextChars);
        const contextEnd = Math.min(pdf.markdown.length, position + matchedText.length + contextChars);
        const context = pdf.markdown.substring(contextStart, contextEnd);
        const section = findSectionForPosition(position);

        matches.push({
          text: matchedText,
          context: context.trim(),
          section,
        });

        totalMatches++;

        if (match.index === regexPattern.lastIndex) {
          regexPattern.lastIndex++;
        }
      }
    } else {
      const searchText = caseSensitive ? query : query.toLowerCase();
      const markdownText = caseSensitive ? pdf.markdown : pdf.markdown.toLowerCase();

      let position = 0;
      while ((position = markdownText.indexOf(searchText, position)) !== -1) {
        if (maxResults && totalMatches >= maxResults) {
          break;
        }

        const matchedText = pdf.markdown.substring(position, position + query.length);
        const contextStart = Math.max(0, position - contextChars);
        const contextEnd = Math.min(pdf.markdown.length, position + query.length + contextChars);
        const context = pdf.markdown.substring(contextStart, contextEnd);
        const section = findSectionForPosition(position);

        matches.push({
          text: matchedText,
          context: context.trim(),
          section,
        });

        totalMatches++;
        position += query.length;
      }
    }

    if (matches.length === 0) {
      return [];
    }

    const groupedBySection: Map<string, Array<{ text: string; context: string }>> = new Map();
    for (const match of matches) {
      const sectionMatches = groupedBySection.get(match.section) || [];
      sectionMatches.push({ text: match.text, context: match.context });
      groupedBySection.set(match.section, sectionMatches);
    }

    const results: SearchResult[] = [];
    for (const [section, sectionMatches] of groupedBySection) {
      results.push({
        page: 0,
        section,
        matches: sectionMatches,
      });
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
      result += `${indent}${item.title}\n`;

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
      const response = await this.fetchWithTimeout(pdf.path);
      if (!response.ok) {
        throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
      }
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
      const response = await this.fetchWithTimeout(pdf.path);
      if (!response.ok) {
        throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
      }
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
      const response = await this.fetchWithTimeout(pdf.path);
      if (!response.ok) {
        throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
      }
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
      const response = await this.fetchWithTimeout(pdf.path);
      if (!response.ok) {
        throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
      }
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