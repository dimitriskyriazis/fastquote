import type { ICellEditorParams } from 'ag-grid-community';

// Custom cell editor for multiline text (Description and Comment cells)
class MultilineTextCellEditor {
  private eInput!: HTMLTextAreaElement;
  private eWrapper!: HTMLDivElement;
  private initialValue: string = '';
  private params!: ICellEditorParams;
  private isMultiline: boolean = false;
  private lastMeasuredWidth: number = 0;

  init(params: ICellEditorParams) {
    this.params = params;
    this.initialValue = params.value ?? '';
    this.isMultiline = this.initialValue.includes('\n');

    // Create wrapper div for positioning
    this.eWrapper = document.createElement('div');
    this.eWrapper.style.position = 'relative';
    this.eWrapper.style.width = '100%';
    this.eWrapper.style.height = '100%';
    this.eWrapper.style.overflow = 'visible';

    // Create textarea
    this.eInput = document.createElement('textarea');
    this.eInput.value = this.initialValue;
    this.eInput.style.border = 'none';
    this.eInput.style.outline = 'none';
    this.eInput.style.resize = 'none';
    this.eInput.style.fontFamily = 'inherit';
    this.eInput.style.fontSize = 'inherit';
    this.eInput.style.lineHeight = '1.5';
    this.eInput.style.boxSizing = 'border-box';
    this.eInput.style.background = 'white';

    if (this.isMultiline) {
      this.applyMultilineStyle();
    } else {
      this.applySingleLineStyle();
    }

    // Handle Alt+Enter to insert line breaks
    this.eInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.altKey) {
        e.preventDefault();
        e.stopPropagation();

        const start = this.eInput.selectionStart;
        const end = this.eInput.selectionEnd;
        const value = this.eInput.value;

        // Insert newline at cursor position
        this.eInput.value = value.substring(0, start) + '\n' + value.substring(end);

        // Move cursor after the newline
        this.eInput.selectionStart = this.eInput.selectionEnd = start + 1;

        // Switch to multi-line mode if not already
        if (!this.isMultiline) {
          this.isMultiline = true;
          this.applyMultilineStyle();
        }

        // Resize row to fit content
        this.resizeToFit();
      }
    });

    // Detect when all line breaks are removed -> switch back to single-line
    this.eInput.addEventListener('input', () => {
      const hasBreaks = this.eInput.value.includes('\n');
      if (this.isMultiline && !hasBreaks) {
        this.isMultiline = false;
        this.applySingleLineStyle();
        // Reset row height back to default
        const node = this.params.node;
        if (node) {
          node.setRowHeight(null);
          this.params.api.onRowHeightChanged();
        }
      }
    });

    this.eWrapper.appendChild(this.eInput);
  }

  private applySingleLineStyle() {
    this.eInput.style.position = 'absolute';
    this.eInput.style.top = '0';
    this.eInput.style.left = '0';
    this.eInput.style.width = '2000px';
    this.eInput.style.height = '100%';
    this.eInput.style.padding = '4px 0';
    this.eInput.style.whiteSpace = 'nowrap';
    this.eInput.style.overflow = 'hidden';
    this.eInput.style.zIndex = '1000';
  }

  private applyMultilineStyle() {
    this.eInput.style.position = 'absolute';
    this.eInput.style.top = '0';
    this.eInput.style.left = '0';
    this.eInput.style.width = '2000px';
    this.eInput.style.height = '100%';
    this.eInput.style.padding = '0';
    this.eInput.style.whiteSpace = 'pre';
    this.eInput.style.overflow = 'hidden';
    this.eInput.style.zIndex = '1000';
  }

  private measureTextWidth(): number {
    const text = this.eInput.value;
    if (!text) return 0;
    const computed = window.getComputedStyle(this.eInput);
    const font = `${computed.fontSize} ${computed.fontFamily}`;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    ctx.font = font;
    const lines = text.split('\n');
    let maxWidth = 0;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      if (w > maxWidth) maxWidth = w;
    }
    return Math.ceil(maxWidth) + 24;
  }

  private resizeToFit() {
    requestAnimationFrame(() => {
      // Calculate height from line count (lineHeight 1.5 * fontSize)
      const lineCount = this.eInput.value.split('\n').length;
      const computed = window.getComputedStyle(this.eInput);
      const fontSize = parseFloat(computed.fontSize) || 14;
      const lineHeight = fontSize * 1.5;
      const neededHeight = Math.ceil(lineCount * lineHeight);

      // Set textarea and row height
      this.eInput.style.height = neededHeight + 'px';

      const node = this.params.node;
      if (node) {
        node.setRowHeight(neededHeight);
        this.params.api.onRowHeightChanged();
      }

      // Measure and store width for use on destroy
      this.lastMeasuredWidth = this.measureTextWidth();
    });
  }

  getGui() {
    return this.eWrapper;
  }

  afterGuiAttached() {
    this.eInput.focus();
    this.eInput.select();
    this.eInput.scrollLeft = 0;
  }

  getValue() {
    return this.eInput.value;
  }

  isCancelBeforeStart() {
    return false;
  }

  isCancelAfterEnd() {
    return false;
  }

  destroy() {
    // Reset scroll position of the cell so it shows the left (beginning) of text
    const cell = this.eWrapper.closest('.ag-cell');
    if (cell) {
      cell.scrollLeft = 0;
      const wrapper = cell.querySelector('.ag-cell-wrapper');
      if (wrapper) (wrapper as HTMLElement).scrollLeft = 0;
      const value = cell.querySelector('.ag-cell-value');
      if (value) (value as HTMLElement).scrollLeft = 0;
    }

  }
}

export default MultilineTextCellEditor;
