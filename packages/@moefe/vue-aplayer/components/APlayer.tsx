/* eslint-disable no-nested-ternary */
/* eslint-disable no-underscore-dangle */
import * as Vue from 'vue-tsx-support';
import Component from 'vue-class-component';
import { Prop, Provide, Watch } from 'vue-property-decorator';
import classNames from 'classnames';
import Audio, { ReadyState, events } from '@moefe/vue-audio';
import Store from '@moefe/vue-store';
import Player, { Notice } from './Player';
import PlayList from './PlayList';
import Lyric from './Lyric';
import { shuffle, HttpRequest } from '../utils';
import '../assets/style/aplayer.scss';

declare global {
  const Hls: any;
}

const instances: APlayer[] = [];
const store = new Store();

@Component
export default class APlayer extends Vue.Component<
  APlayer.Options,
  APlayer.Events
> {
  public static readonly version: string = APLAYER_VERSION;

  public readonly $refs!: {
    container: HTMLDivElement;
  };

  // #region [只读] 播放器选项
  @Prop({ type: Boolean, required: false, default: false })
  private readonly fixed!: boolean;

  @Prop({ type: Boolean, required: false, default: null })
  private readonly mini!: boolean;

  @Prop({ type: Boolean, required: false, default: false })
  private readonly autoplay!: boolean;

  @Prop({ type: String, required: false, default: '#b7daff' })
  private readonly theme!: string;

  @Prop({ type: String, required: false, default: 'all' })
  private readonly loop!: APlayer.LoopMode;

  @Prop({ type: String, required: false, default: 'list' })
  private readonly order!: APlayer.OrderMode;

  @Prop({ type: String, required: false, default: 'auto' })
  private readonly preload!: APlayer.Preload;

  @Prop({ type: Number, required: false, default: 0.7 })
  private readonly volume!: number;

  @Prop({ type: [Object, Array], required: true })
  private readonly audio!: APlayer.Audio | Array<APlayer.Audio>;

  @Prop({ type: Object, required: false })
  private readonly customAudioType?: any;

  @Prop({ type: Boolean, required: false, default: true })
  private readonly mutex!: boolean;

  @Prop({ type: Number, required: false, default: 0 })
  private readonly lrcType!: APlayer.LrcType;

  @Prop({ type: Boolean, required: false, default: false })
  private readonly listFolded!: boolean;

  @Prop({ type: Number, required: false, default: 250 })
  private readonly listMaxHeight!: number;

  @Prop({ type: String, required: false, default: 'aplayer-setting' })
  private readonly storageName!: string;
  // #endregion

  // 提供当前实例的引用，让子组件获取该实例的可响应数据
  @Provide()
  private get aplayer() {
    return this;
  }

  private get settings(): APlayer.Settings[] {
    return this.store.store;
  }

  public get currentSettings(): APlayer.Settings {
    return this.settings[instances.indexOf(this)];
  }

  // 当前播放模式对应的播放列表
  private get currentList() {
    return this.currentOrder === 'list' ? this.orderList : this.randomList;
  }

  // 顺序播放列表，数据源，自动生成 ID 作为播放列表项的 key
  private get orderList(): APlayer.Audio[] {
    return (Array.isArray(this.audio) ? this.audio : [this.audio])
      .filter(x => x)
      .map((item, index) => ({
        id: index + 1,
        ...item,
      }));
  }

  // 根据顺序播放列表生成随机播放列表
  private get randomList(): APlayer.Audio[] {
    return shuffle([...this.orderList]);
  }

  // eslint-disable-next-line class-methods-use-this
  private get isMobile(): boolean {
    return /mobile/i.test(window.navigator.userAgent);
  }

  // 是否正在缓冲
  private get isLoading(): boolean {
    return (
      !this.media.paused && this.media.readyState < ReadyState.HAVE_FUTURE_DATA
    );
  }

  private readonly _uid!: number;
  private readonly options!: APlayer.InstallOptions;
  private isDraggingProgressBar = false; // 是否正在拖动进度条（防止抖动）
  private isAwaitChangeProgressBar = false; // 是否正在等待进度条更新（防止抖动）
  private isMini = this.mini !== null ? this.mini : this.fixed; // 是否是迷你模式
  private isArrow = false; // 是否是 arrow 模式
  private canPlay = !this.isMobile && this.autoplay; // 当 currentMusic 改变时是否允许播放
  private listVisible = !this.listFolded; // 播放列表是否可见
  private get listScrollTop(): number {
    return this.currentListIndex * 33;
  }
  private lyricVisible = true; // 控制迷你模式下的歌词是否可见
  private img = new Image(); // 封面图片对象
  private xhr = new HttpRequest(); // 封面下载对象
  private media = new Audio(); // 响应式媒体对象
  private player = this.media.audio; // 核心音频对象
  private store = store;

  // 当前播放的音乐
  private currentMusic: APlayer.Audio = {
    id: NaN,
    name: '未加载音频',
    artist: '(ಗ ‸ ಗ )',
    url: '',
  };

  // 当前播放的音乐索引
  public get currentIndex(): number {
    return this.currentOrder === 'list'
      ? this.currentListIndex
      : this.currentRandomIndex;
  }

  private get currentListIndex(): number {
    const { id, url } = this.currentMusic;
    return this.orderList.findIndex(
      item => item.id === id || item.url === url,
    );
  }

  private get currentRandomIndex() {
    const { id, url } = this.currentMusic;
    return this.randomList.findIndex(
      item => item.id === id || item.url === url,
    );
  }

  // 当前已缓冲比例
  private get currentLoaded(): number {
    if (this.media.readyState < ReadyState.HAVE_FUTURE_DATA) return 0;
    const { length } = this.media.buffered;
    return length > 0
      ? this.media.buffered.end(length - 1) / this.media.duration
      : 1;
  }

  private currentPlayed = 0; // 当前已播放比例
  private currentVolume = this.volume; // 当前音量
  private currentLoop = this.loop; // 当前循环模式
  private currentOrder = this.order; // 当前顺序模式
  private currentTheme = this.currentMusic.theme || this.theme; // 当前主题，通过封面自适应主题 > 当前播放的音乐指定的主题 > 主题选项
  private notice: Notice = { text: '', time: 2000, opacity: 0 }; // 通知信息

  // #region 监听属性

  @Watch('currentList', { immediate: true, deep: true })
  private handleChangeDataSource(
    newList: APlayer.Audio[],
    oldList?: APlayer.Audio[],
  ) {
    if (oldList) {
      const newLength = newList.length;
      const oldLength = oldList.length;
      if (newLength !== oldLength) {
        if (newLength <= 0) this.$emit('listClear');
        else if (newLength > oldLength) this.$emit('listAdd');
        else {
          if (this.currentIndex < 0) {
            const { id, url } = this.currentMusic;
            const oldIndex = oldList.findIndex(
              item => item.id === id || item.url === url,
            );
            Object.assign(this.currentMusic, oldList[oldIndex - 1]);
          }
          this.canPlay = !this.player.paused;
          this.$emit('listRemove');
        }
      }
    }

    if (this.currentList.length > 0) {
      if (
        this.currentMusic.id !== undefined &&
        Number.isNaN(this.currentMusic.id)
      ) {
        [this.currentMusic] = this.currentList;
      } else {
        const music = this.currentList[this.currentIndex];
        Object.assign(this.currentMusic, music);
      }
    }
  }

  @Watch('currentMusic', { immediate: true, deep: true })
  private async handleChangeCurrentMusic(
    newMusic: APlayer.Audio,
    oldMusic?: APlayer.Audio,
  ) {
    if (newMusic.theme) {
      this.currentTheme = newMusic.theme;
    } else {
      const cover = newMusic.cover || this.options.defaultCover;
      if (cover) {
        setTimeout(async () => {
          try {
            this.currentTheme = await this.getThemeColorFromCover(cover);
          } catch (e) {
            this.currentTheme = newMusic.theme || this.theme;
          }
        });
      }
    }

    if (newMusic.url) {
      if (
        (oldMusic !== undefined && oldMusic.url) !== newMusic.url ||
        this.player.src !== newMusic.url
      ) {
        this.currentPlayed = 0;
        if (oldMusic) {
          // 首次初始化时不要触发事件
          this.handleChangeSettings();
          this.$emit('listSwitch', newMusic);
        }
        const src = await this.getAudioUrl(newMusic);
        if (src) this.player.src = src;
        this.player.playbackRate = newMusic.speed || 1;
        this.player.preload = this.preload;
        this.player.volume = this.currentVolume;
        this.player.currentTime = 0;
        this.player.onerror = (e: ErrorEvent) => this.showNotice(e.message);
      }
      if (this.canPlay) this.play();
      this.canPlay = true;
    }
  }

  @Watch('volume')
  private handleChangeVolume(volume: number) {
    this.currentVolume = volume;
  }

  @Watch('currentVolume')
  private handleChangeCurrentVolume() {
    this.player.volume = this.currentVolume;
    this.$emit('update:volume', this.currentVolume);
  }

  @Watch('media.currentTime')
  private handleChangeCurrentTime() {
    if (!this.isDraggingProgressBar && !this.isAwaitChangeProgressBar) {
      this.currentPlayed = this.media.currentTime / this.media.duration;
    }
  }

  @Watch('media.$data', { deep: true })
  private handleChangeSettings() {
    const settings: APlayer.Settings = {
      currentTime: this.media.currentTime,
      duration: this.media.duration,
      paused: this.media.paused,
      mini: this.isMini,
      lrc: this.lyricVisible,
      list: this.listVisible,
      volume: this.currentVolume,
      loop: this.currentLoop,
      order: this.currentOrder,
      music: this.currentMusic,
    };

    if (settings.volume <= 0) {
      settings.volume = this.currentSettings.volume;
    }

    const instanceIndex = instances.indexOf(this);
    this.store.set(
      this.settings[instanceIndex] !== undefined
        ? this.settings.map(
            (item, index) => (index === instanceIndex ? settings : item),
          )
        : [...this.settings, settings],
    );
  }

  @Watch('media.ended')
  private handleChangeEnded() {
    if (!this.media.ended) return;
    this.currentPlayed = 0;
    switch (this.currentLoop) {
      default:
      case 'all':
        this.handleSkipForward();
        break;
      case 'one':
        this.play();
        break;
      case 'none':
        if (this.currentIndex === this.currentList.length - 1) {
          [this.currentMusic] = this.currentList;
          this.pause();
          this.canPlay = false;
        } else this.handleSkipForward();
        break;
    }
  }

  @Watch('mini')
  private handleChangeMini() {
    this.isMini = this.mini;
  }

  @Watch('isMini', { immediate: true })
  private async handleChangeCurrentMini(newVal: boolean, oldVal?: boolean) {
    await this.$nextTick();
    const { container } = this.$refs;
    this.isArrow = container && container.offsetWidth <= 300;
    if (oldVal !== undefined) {
      this.$emit('update:mini', this.isMini);
      this.handleChangeSettings();
    }
  }

  @Watch('loop')
  private handleChangeLoop() {
    this.currentLoop = this.loop;
  }

  @Watch('currentLoop')
  private handleChangeCurrentLoop() {
    this.$emit('update:loop', this.currentLoop);
    this.handleChangeSettings();
  }

  @Watch('order')
  private handleChangeOrder() {
    this.currentOrder = this.order;
  }

  @Watch('currentOrder')
  private handleChangeCurrentOrder() {
    this.$emit('update:order', this.currentOrder);
    this.handleChangeSettings();
  }

  @Watch('listVisible')
  private handleChangeListVisible() {
    this.$emit(this.listVisible ? 'listShow' : 'listHide');
    this.$emit('update:listFolded', this.listVisible);
    this.handleChangeSettings();
  }

  @Watch('lyricVisible')
  private handleChangeLyricVisible() {
    this.$emit(this.lyricVisible ? 'lrcShow' : 'lrcHide');
    this.handleChangeSettings();
  }

  // #endregion

  // #region 公开 API

  public async play() {
    try {
      if (this.mutex) this.pauseOtherInstances();
      await this.player.play();
    } catch (e) {
      if (!this.isMini) this.showNotice(e.message);
    }
  }

  public pause() {
    this.player.pause();
  }

  private async seeking(percent: number, paused: boolean = true) {
    try {
      this.isAwaitChangeProgressBar = true;
      if (this.preload === 'none') {
        if (!this.player.src) await this.media.srcLoaded();
        const oldPaused = this.player.paused;
        await this.play(); // preload 为 none 的情况下必须先 play
        if (paused && oldPaused) this.pause();
      }
      await this.media.loaded();
      this.player.currentTime = percent * this.media.duration;
      if (paused) this.pause();
      else this.play();
    } catch (e) {
      this.showNotice(e.message);
    } finally {
      this.isAwaitChangeProgressBar = false;
    }
  }

  public seek(time: number) {
    this.seeking(time / this.media.duration, this.media.paused);
  }

  public toggle() {
    if (this.media.paused) this.play();
    else this.pause();
  }

  public skipBack() {
    const playIndex = this.getPlayIndexByMode('skipBack');
    this.currentMusic = { ...this.currentList[playIndex] };
  }

  public skipForward() {
    const playIndex = this.getPlayIndexByMode('skipForward');
    this.currentMusic = { ...this.currentList[playIndex] };
  }

  public showLrc() {
    this.lyricVisible = true;
  }

  public hideLrc() {
    this.lyricVisible = false;
  }

  public toggleLrc() {
    this.lyricVisible = !this.lyricVisible;
  }

  public showList() {
    this.listVisible = true;
  }

  public hideList() {
    this.listVisible = false;
  }

  public toggleList() {
    this.listVisible = !this.listVisible;
  }

  public showNotice(
    text: string,
    time: number = 2000,
    opacity: number = 0.8,
  ): Promise<void> {
    return new Promise((resolve) => {
      this.notice = { text, time, opacity };
      this.$emit('noticeShow');
      if (time > 0) {
        setTimeout(() => {
          this.notice.opacity = 0;
          this.$emit('noticeHide');
          resolve();
        }, time);
      }
    });
  }

  // #endregion

  // #region 私有 API

  // 从封面中获取主题颜色
  private getThemeColorFromCover(url: string): Promise<string> {
    return new Promise<string>(async (resolve, reject) => {
      try {
        if (typeof ColorThief !== 'undefined') {
          const image = await this.xhr.download<Blob>(url, 'blob');
          const reader = new FileReader();
          reader.onload = () => {
            this.img.src = reader.result as string;
            this.img.crossOrigin = '';
            this.img.onload = () => {
              const [r, g, b] = new ColorThief().getColor(this.img);
              const theme = `rgb(${r}, ${g}, ${b})`;
              resolve(theme || this.currentMusic.theme || this.theme);
            };
            this.img.onabort = reject;
            this.img.onerror = reject;
          };
          reader.onabort = reject;
          reader.onerror = reject;
          reader.readAsDataURL(image);
        } else resolve(this.currentMusic.theme || this.theme);
      } catch (e) {
        resolve(this.currentMusic.theme || this.theme);
      }
    });
  }

  private getAudioUrl(music: APlayer.Audio): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let { type } = music;
      if (type && this.customAudioType && this.customAudioType[type]) {
        if (typeof this.customAudioType[type] === 'function') {
          this.customAudioType[type](this.player, music, this);
        } else {
          // eslint-disable-next-line no-console
          console.error(`Illegal customType: ${type}`);
        }
        resolve();
      } else {
        if (!type || type === 'auto') {
          type = /m3u8(#|\?|$)/i.test(music.url) ? 'hls' : 'normal';
        }
        if (type === 'hls') {
          try {
            if (Hls.isSupported()) {
              const hls: Hls = new Hls();
              hls.loadSource(music.url);
              hls.attachMedia(this.player as HTMLVideoElement);
              resolve();
            } else if (
              this.player.canPlayType('application/x-mpegURL') ||
              this.player.canPlayType('application/vnd.apple.mpegURL')
            ) {
              resolve(music.url);
            } else {
              reject(new Error('HLS is not supported.'));
            }
          } catch (e) {
            reject(new Error('HLS is not supported.'));
          }
        } else {
          resolve(music.url);
        }
      }
    });
  }

  private getPlayIndexByMode(type: 'skipBack' | 'skipForward'): number {
    const { length } = this.currentList;
    const index = this.currentIndex;
    return (type === 'skipBack' ? length + (index - 1) : index + 1) % length;
  }

  private pauseOtherInstances() {
    instances
      .filter(x => x._uid !== this._uid)
      .forEach(inst => inst.pause());
  }

  // #endregion

  // #region 事件处理

  // 切换上一曲
  private handleSkipBack() {
    this.skipBack();
  }

  // 切换下一曲
  private handleSkipForward() {
    this.skipForward();
  }

  // 切换播放
  private handleTogglePlay() {
    this.toggle();
  }

  // 处理切换顺序模式
  private handleToggleOrderMode() {
    this.currentOrder = this.currentOrder === 'list' ? 'random' : 'list';
  }

  // 处理切换循环模式
  private handleToggleLoopMode() {
    this.currentLoop =
      this.currentLoop === 'all'
        ? 'one'
        : this.currentLoop === 'one'
          ? 'none'
          : 'all';
  }

  // 处理切换播放/暂停事件
  private handleTogglePlaylist() {
    this.toggleList();
  }

  // 处理切换歌词显隐事件
  private handleToggleLyric() {
    this.toggleLrc();
  }

  // 处理进度条改变事件
  private handleChangeProgress(e: MouseEvent | TouchEvent, percent: number) {
    this.currentPlayed = percent;
    this.isDraggingProgressBar = e.type.includes('move');
    if (['touchend', 'mouseup'].includes(e.type)) {
      this.seeking(percent, this.media.paused); // preload 为 none 的情况下无法获取到 duration
    }
  }

  // 处理切换迷你模式事件
  private handleMiniSwitcher() {
    this.isMini = !this.isMini;
  }

  // 处理播放曲目改变事件
  private handleChangePlaylist(music: APlayer.Audio) {
    if (music.id === this.currentMusic.id) this.handleTogglePlay();
    else this.currentMusic = music;
  }
  // #endregion

  beforeMount() {
    instances.push(this);
    this.store.key = this.storageName;
    if (this.currentSettings) {
      const {
        mini,
        lrc,
        list,
        volume,
        loop,
        order,
        music,
        currentTime,
        duration,
        paused,
      } = this.currentSettings;
      this.isMini = mini;
      this.lyricVisible = lrc;
      this.listVisible = list;
      this.currentVolume = volume;
      this.currentLoop = loop;
      this.currentOrder = order;
      if (music) {
        this.currentMusic = music;
        if (duration) {
          this.seeking(currentTime / duration, paused);
        }
      }
    }
    events.forEach((event) => {
      this.player.addEventListener(event, e => this.$emit(event, e));
    });
  }

  beforeDestroy() {
    const instanceIndex = instances.indexOf(this);
    instances.splice(instanceIndex, 1);
    this.store.set(
      this.settings.map(
        (item, index) => (index === instanceIndex ? null : item),
      ),
    );
    this.pause();
    this.$emit('destroy');
    this.$el.remove();
  }

  render() {
    const {
      orderList,
      fixed,
      lrcType,
      isMini,
      isMobile,
      isArrow,
      isLoading,
      notice,
      listVisible,
      listScrollTop,
      currentMusic,
      lyricVisible,
    } = this;

    return (
      <div
        ref="container"
        class={classNames({
          aplayer: true,
          'aplayer-withlist': orderList.length > 1,
          'aplayer-withlrc': !fixed && (lrcType !== 0 && lyricVisible),
          'aplayer-narrow': isMini,
          'aplayer-fixed': fixed,
          'aplayer-mobile': isMobile,
          'aplayer-arrow': isArrow,
          'aplayer-loading': isLoading,
        })}
      >
        <Player
          notice={notice}
          onSkipBack={this.handleSkipBack}
          onSkipForward={this.handleSkipForward}
          onTogglePlay={this.handleTogglePlay}
          onToggleOrderMode={this.handleToggleOrderMode}
          onToggleLoopMode={this.handleToggleLoopMode}
          onTogglePlaylist={this.handleTogglePlaylist}
          onToggleLyric={this.handleToggleLyric}
          onChangeVolume={this.handleChangeVolume}
          onChangeProgress={this.handleChangeProgress}
          onMiniSwitcher={this.handleMiniSwitcher}
        />
        <PlayList
          visible={listVisible}
          scrollTop={listScrollTop}
          currentMusic={currentMusic}
          dataSource={orderList}
          onChange={this.handleChangePlaylist}
        />
        {fixed && lrcType !== 0 ? <Lyric visible={lyricVisible} /> : null}
      </div>
    );
  }
}
