import Events from 'node:events';
import debug, { type Debugger } from 'debug';
import {
  BrowserView,
  BrowserWindow,
  clipboard,
  type DesktopCapturerSource,
  desktopCapturer,
  dialog,
  type IpcMainEvent,
  ipcMain,
  nativeImage,
  screen,
} from 'electron';
import fs from 'fs-extra';
import Event from './event.js';
import { type Display, getDisplays } from './getDisplay.js';
import padStart from './padStart.js';
import type { Bounds, ScreenshotsData } from './preload.js';

export type LoggerFn = (...args: unknown[]) => void;
export type Logger = Debugger | LoggerFn;

export interface Lang {
  magnifier_position_label?: string;
  operation_ok_title?: string;
  operation_cancel_title?: string;
  operation_save_title?: string;
  operation_redo_title?: string;
  operation_undo_title?: string;
  operation_mosaic_title?: string;
  operation_text_title?: string;
  operation_brush_title?: string;
  operation_arrow_title?: string;
  operation_ellipse_title?: string;
  operation_rectangle_title?: string;
}

export interface ScreenshotsOpts {
  lang?: Lang;
  logger?: Logger;
  singleWindow?: boolean;
}

export type { Bounds };

interface CaptureView {
  isReady: Promise<void>;
  view: BrowserView;
}

interface CaptureWindow extends CaptureView {
  display: Display;
  win: BrowserWindow;
}

export default class Screenshots extends Events {
  // 截图窗口对象
  public $win: BrowserWindow | null = null;

  public $view!: BrowserView;

  private logger: Logger;

  private singleWindow: boolean;

  private isReady!: Promise<void>;

  private lang?: Partial<Lang>;

  private targets = new Map<number, CaptureWindow>();

  private pendingReady = new Map<number, () => void>();

  private pendingReset = new Map<number, () => void>();

  private viewUrl = `file://${require.resolve(
    'react-screenshots/dist/electron.html',
  )}`;

  constructor(opts?: ScreenshotsOpts) {
    super();
    this.logger = opts?.logger || debug('electron-screenshots');
    this.singleWindow = opts?.singleWindow || false;
    this.listenIpc();
    const captureView = this.createView();
    this.$view = captureView.view;
    this.isReady = captureView.isReady;
    if (opts?.lang) {
      this.setLang(opts.lang);
    }
  }

  /**
   * 开始截图
   */
  public async startCapture(): Promise<void> {
    this.logger('startCapture');

    const captures = await Promise.all(
      getDisplays().map(async (display) => ({
        display,
        imageUrl: await this.capture(display),
      })),
    );

    for (const { display } of captures) {
      await this.createWindow(display);
    }

    await Promise.all(
      captures.map(async ({ display, imageUrl }) => {
        const target = this.targets.get(display.id);
        if (!target) {
          return;
        }
        await target.isReady;
        target.view.webContents.send(
          'SCREENSHOTS:capture',
          display,
          imageUrl,
        );
      }),
    );
  }

  /**
   * 结束截图
   */
  public async endCapture(): Promise<void> {
    this.logger('endCapture');
    await this.reset();

    if (!this.targets.size) {
      return;
    }

    // 先清除 Kiosk 模式，然后取消全屏才有效
    for (const target of this.targets.values()) {
      target.win.setKiosk(false);
      target.win.blur();
      target.win.blurWebView();
      target.win.unmaximize();
      target.win.removeBrowserView(target.view);

      if (this.singleWindow) {
        target.win.hide();
      } else {
        target.win.destroy();
      }
    }
  }

  /**
   * 设置语言
   */
  public async setLang(lang: Partial<Lang>): Promise<void> {
    this.logger('setLang', lang);

    this.lang = lang;

    const targets = this.getCaptureViews();
    await Promise.all(targets.map((target) => target.isReady));

    for (const target of targets) {
      target.view.webContents.send('SCREENSHOTS:setLang', lang);
    }
  }

  private createView(): CaptureView {
    const view = new BrowserView({
      webPreferences: {
        preload: require.resolve('./preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const isReady = new Promise<void>((resolve) => {
      this.pendingReady.set(view.webContents.id, resolve);
    });

    view.webContents.loadURL(this.viewUrl);

    return { isReady, view };
  }

  private getReusableView(displayId: number): CaptureView {
    if (!this.targets.size && !this.targets.has(displayId)) {
      if (this.$view.webContents.isDestroyed()) {
        const captureView = this.createView();
        this.$view = captureView.view;
        this.isReady = captureView.isReady;
      }
      return {
        isReady: this.isReady,
        view: this.$view,
      };
    }

    return this.createView();
  }

  private getCaptureViews(): CaptureView[] {
    const targets = [...this.targets.values()];
    if (targets.length) {
      return targets;
    }
    return [{ isReady: this.isReady, view: this.$view }];
  }

  private async resetView(target: CaptureView): Promise<void> {
    await target.isReady;

    target.view.webContents.send('SCREENSHOTS:reset');

    const webContentsId = target.view.webContents.id;
    await Promise.race([
      new Promise<void>((resolve) => {
        setTimeout(() => {
          this.pendingReset.delete(webContentsId);
          resolve();
        }, 500);
      }),
      new Promise<void>((resolve) => {
        this.pendingReset.set(webContentsId, resolve);
      }),
    ]);
  }

  private async reset() {
    // 重置截图区域
    await Promise.all(
      this.getCaptureViews().map((target) => this.resetView(target)),
    );

    // 保证 UI 有足够的时间渲染
  }

  /**
   * 初始化窗口
   */
  private async createWindow(display: Display): Promise<void> {
    let target = this.targets.get(display.id);
    // 重置截图区域
    await this.reset();

    // 复用未销毁的窗口
    if (!target || target.win.isDestroyed()) {
      const captureView = this.getReusableView(display.id);
      const windowTypes: Record<string, string | undefined> = {
        darwin: 'panel',
        // linux 必须设置为 undefined，否则会在部分系统上不能触发focus 事件
        // https://github.com/nashaofu/screenshots/issues/203#issuecomment-1518923486
        linux: undefined,
        win32: 'toolbar',
      };

      const $win = new BrowserWindow({
        title: 'screenshots',
        x: display.x,
        y: display.y,
        width: display.width,
        height: display.height,
        useContentSize: true,
        type: windowTypes[process.platform] as string,
        frame: false,
        show: false,
        autoHideMenuBar: true,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        // focusable 必须设置为 true, 否则窗口不能及时响应esc按键，输入框也不能输入
        focusable: true,
        skipTaskbar: true,
        alwaysOnTop: true,
        /**
         * linux 下必须设置为false，否则不能全屏显示在最上层
         * mac 下设置为false，否则可能会导致程序坞不恢复问题，且与 kiosk 模式冲突
         */
        fullscreen: false,
        // mac fullscreenable 设置为 true 会导致应用崩溃
        fullscreenable: false,
        kiosk: true,
        backgroundColor: '#00000000',
        titleBarStyle: 'hidden',
        hasShadow: false,
        paintWhenInitiallyHidden: false,
        // mac 特有的属性
        roundedCorners: false,
        enableLargerThanScreen: false,
        acceptFirstMouse: true,
      });

      target = { ...captureView, display, win: $win };
      this.targets.set(display.id, target);
      this.$win = this.$win ?? $win;
      this.$view = this.$view ?? captureView.view;

      this.emit('windowCreated', $win);
      $win.on('show', () => {
        $win.focus();
        $win.setKiosk(true);
      });

      $win.on('closed', () => {
        this.emit('windowClosed', $win);
        this.targets.delete(display.id);
        if (this.$win === $win) {
          const nextTarget = this.targets.values().next().value;
          this.$win = nextTarget ? nextTarget.win : null;
        }
      });
    }

    if (!target) {
      return;
    }

    target.win.setBrowserView(target.view);

    // 适定平台
    if (process.platform === 'darwin') {
      target.win.setWindowButtonVisibility(false);
    }

    if (process.platform !== 'win32') {
      target.win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }

    target.win.blur();
    target.win.setBounds(display);
    target.view.setBounds({
      x: 0,
      y: 0,
      width: display.width,
      height: display.height,
    });
    target.win.setAlwaysOnTop(true);
    target.win.show();
  }

  private async capture(display: Display): Promise<string> {
    this.logger('SCREENSHOTS:capture');

    try {
      const { Monitor } = await import('node-screenshots');
      let point = {
        x: display.x + display.width / 2,
        y: display.y + display.height / 2,
      };
      if (process.platform === 'win32') {
        point = screen.screenToDipPoint(point);
      }
      const monitor = Monitor.fromPoint(point.x, point.y);
      this.logger(
        'SCREENSHOTS:capture Monitor.fromPoint arguments %o',
        display,
      );
      this.logger('SCREENSHOTS:capture Monitor.fromPoint return %o', {
        id: monitor?.id,
        name: monitor?.name,
        x: monitor?.x,
        y: monitor?.y,
        width: monitor?.width,
        height: monitor?.height,
        rotation: monitor?.rotation,
        scaleFactor: monitor?.scaleFactor,
        frequency: monitor?.frequency,
        isPrimary: monitor?.isPrimary,
      });

      if (!monitor) {
        throw new Error(`Monitor.fromDisplay(${display.id}) get null`);
      }

      const image = await monitor.captureImage();
      const buffer = await image.toPng(true);
      return `data:image/png;base64,${buffer.toString('base64')}`;
    } catch (err) {
      this.logger('SCREENSHOTS:capture Monitor capture() error %o', err);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: display.width * display.scaleFactor,
          height: display.height * display.scaleFactor,
        },
      });

      let source: DesktopCapturerSource | undefined;
      // Linux系统上，screen.getDisplayNearestPoint 返回的 Display 对象的 id
      // 和这里 source 对象上的 display_id(Linux上，这个值是空字符串) 或 id 的中间部分，都不一致
      // 但是，如果只有一个显示器的话，其实不用判断，直接返回就行
      if (sources.length === 1) {
        [source] = sources;
      } else {
        source = sources.find(
          (item) =>
            item.display_id === display.id.toString() ||
            item.id.startsWith(`screen:${display.id}:`),
        );
      }

      if (!source) {
        this.logger(
          "SCREENSHOTS:capture Can't find screen source. sources: %o, display: %o",
          sources,
          display,
        );
        throw new Error("Can't find screen source");
      }

      return source.thumbnail.toDataURL();
    }
  }

  /**
   * 绑定ipc时间处理
   */
  private listenIpc(): void {
    ipcMain.on('SCREENSHOTS:ready', (event: IpcMainEvent) => {
      this.logger('SCREENSHOTS:ready');

      const resolve = this.pendingReady.get(event.sender.id);
      if (!resolve) {
        return;
      }

      this.pendingReady.delete(event.sender.id);
      resolve();

      if (this.lang) {
        event.sender.send('SCREENSHOTS:setLang', this.lang);
      }
    });

    ipcMain.on('SCREENSHOTS:reset', (event: IpcMainEvent) => {
      const resolve = this.pendingReset.get(event.sender.id);
      if (!resolve) {
        return;
      }

      this.pendingReset.delete(event.sender.id);
      resolve();
    });
    /**
     * OK事件
     */
    ipcMain.on(
      'SCREENSHOTS:ok',
      (_event, buffer: Buffer, data: ScreenshotsData) => {
        this.logger(
          'SCREENSHOTS:ok buffer.length %d, data: %o',
          buffer.length,
          data,
        );

        const event = new Event();
        this.emit('ok', event, buffer, data);
        if (event.defaultPrevented) {
          return;
        }
        clipboard.writeImage(nativeImage.createFromBuffer(buffer));
        this.endCapture();
      },
    );
    /**
     * CANCEL事件
     */
    ipcMain.on('SCREENSHOTS:cancel', () => {
      this.logger('SCREENSHOTS:cancel');

      const event = new Event();
      this.emit('cancel', event);
      if (event.defaultPrevented) {
        return;
      }
      this.endCapture();
    });

    /**
     * SAVE事件
     */
    ipcMain.on(
      'SCREENSHOTS:save',
      async (_event: IpcMainEvent, buffer: Buffer, data: ScreenshotsData) => {
        this.logger(
          'SCREENSHOTS:save buffer.length %d, data: %o',
          buffer.length,
          data,
        );

        const event = new Event();
        this.emit('save', event, buffer, data);
        const $win = this.targets.get(data.display.id)?.win ?? this.$win;
        if (event.defaultPrevented || !$win) {
          return;
        }

        const time = new Date();
        const year = time.getFullYear();
        const month = padStart(time.getMonth() + 1, 2, '0');
        const date = padStart(time.getDate(), 2, '0');
        const hours = padStart(time.getHours(), 2, '0');
        const minutes = padStart(time.getMinutes(), 2, '0');
        const seconds = padStart(time.getSeconds(), 2, '0');
        const milliseconds = padStart(time.getMilliseconds(), 3, '0');

        for (const target of this.targets.values()) {
          target.win.setAlwaysOnTop(false);
        }

        const { canceled, filePath } = await dialog.showSaveDialog($win, {
          defaultPath: `${year}${month}${date}${hours}${minutes}${seconds}${milliseconds}.png`,
          filters: [
            { name: 'Image (png)', extensions: ['png'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        });

        if ($win.isDestroyed()) {
          this.emit('afterSave', new Event(), buffer, data, false); // isSaved = false
          return;
        }

        for (const target of this.targets.values()) {
          target.win.setAlwaysOnTop(true);
        }
        if (canceled || !filePath) {
          this.emit('afterSave', new Event(), buffer, data, false); // isSaved = false
          return;
        }

        await fs.writeFile(filePath, buffer);
        this.emit('afterSave', new Event(), buffer, data, true); // isSaved = true
        this.endCapture();
      },
    );
  }
}
