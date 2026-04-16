import { Collection, Convertable } from "@/download-objects/Collection.js";
import { generateAlbumItem } from "@/download-objects/generateAlbumItem.js";
import { generateTrackItem } from "@/download-objects/generateTrackItem.js";
import {
	AlbumNotOnDeezer,
	InvalidID,
	PluginNotEnabledError,
	SpotifyPlaylistNotAccessible,
	TrackNotOnDeezer,
} from "@/errors.js";
import { type Settings } from "@/types/Settings.js";
import { getConfigFolder } from "@/utils/localpaths.js";
import {
	type Market,
	SpotifyApi,
	type Track as SpotifyTrack,
	type AccessToken,
	type IAuthStrategy,
} from "@spotify/web-api-ts-sdk";
import { queue } from "async";
import { Deezer, type DeezerTrack } from "deezer-sdk";
import { randomBytes } from "crypto";
import fs from "fs";
import got from "got";
import { sep } from "path";
import BasePlugin from "./base.js";

interface CachedTrack {
	id?: number;
	isrc?: string;
	data?: {
		title?: string;
		artist: string;
		album: string;
	};
}

interface SpotifyDownloadHistoryTrack {
	id: string;
	uri?: string;
	name: string;
	artists: string[];
	album?: string;
	deezerId?: string;
	deezerTitle?: string;
	path?: string;
	firstDownloadedAt: string;
	lastDownloadedAt: string;
}

interface SpotifyDownloadHistoryPlaylist {
	id: string;
	name: string;
	owner?: string;
	snapshotId?: string;
	totalTracks: number;
	lastSeenAt: string;
	lastDownloadedAt?: string;
	downloadedCount: number;
	tracks: Record<string, SpotifyDownloadHistoryTrack>;
}

interface SpotifyDownloadHistory {
	version: 1;
	playlists: Record<string, SpotifyDownloadHistoryPlaylist>;
}

interface SpotifySyncTrack {
	id: string;
	uri?: string;
	name: string;
	artists: string[];
	album?: string;
}

interface SpotifyPlaylistSyncData {
	playlistId: string;
	playlistName: string;
	owner?: string;
	snapshotId?: string;
	totalTracks: number;
	queuedTrackIds: string[];
	skippedTrackIds: string[];
	tracks: Record<string, SpotifySyncTrack>;
}

interface SpotifyDownloadStatus {
	downloaded: boolean;
	mirrored: boolean;
	downloadedCount: number;
	totalTracks: number;
	lastDownloadedAt?: string;
}

export interface SpotifyUser {
	id: string;
	name?: string | null;
	picture?: string | null;
}

class StoredSpotifyAccessTokenStrategy implements IAuthStrategy {
	constructor(
		private readonly clientId: string,
		private accessToken: AccessToken,
		private readonly refreshAccessToken: (
			clientId: string,
			token: AccessToken
		) => Promise<AccessToken>
	) {
		if (!this.accessToken.expires) {
			this.accessToken.expires = this.calculateExpiry(this.accessToken);
		}
	}

	setConfiguration(): void {}

	async getOrCreateAccessToken(): Promise<AccessToken> {
		if (this.accessToken.expires && this.accessToken.expires <= Date.now()) {
			this.accessToken = await this.refreshAccessToken(
				this.clientId,
				this.accessToken
			);
		}

		return this.accessToken;
	}

	async getAccessToken(): Promise<AccessToken | null> {
		return this.accessToken;
	}

	removeAccessToken(): void {
		this.accessToken = {
			access_token: "",
			token_type: "",
			expires_in: 0,
			refresh_token: "",
			expires: 0,
		};
	}

	private calculateExpiry(token: AccessToken) {
		return Date.now() + token.expires_in * 1000;
	}
}

export default class SpotifyPlugin extends BasePlugin {
	credentials: { clientId: string; clientSecret: string };
	settings: {
		fallbackSearch: boolean;
		accessToken?: AccessToken;
		user?: SpotifyUser;
	};
	enabled: boolean;
	configFolder: string;
	sp: SpotifyApi;
	private authorizationStates: Map<
		string,
		{ createdAt: number; redirectUri: string }
	>;

	constructor(configFolder = undefined) {
		super();
		this.credentials = { clientId: "", clientSecret: "" };
		this.settings = {
			fallbackSearch: false,
		};
		this.enabled = false;
		this.authorizationStates = new Map();
		/* this.sp */
		this.configFolder = configFolder || getConfigFolder();
		this.configFolder += `spotify${sep}`;
		return this;
	}

	override setup() {
		fs.mkdirSync(this.configFolder, { recursive: true });

		this.loadSettings();
		return this;
	}

	override async parseLink(link: string) {
		if (link.includes("link.tospotify.com")) {
			const response = await got.get(link, {
				https: { rejectUnauthorized: false },
			}); // Resolve URL shortner
			link = response.url;
		}

		// Remove extra stuff
		if (link.includes("?")) link = link.slice(0, link.indexOf("?"));
		if (link.includes("&")) link = link.slice(0, link.indexOf("&"));
		if (link.endsWith("/")) link = link.slice(0, -1); // Remove last slash if present

		if (!link.includes("spotify")) return [link, undefined, undefined]; // return if not a spotify link

		let link_type: string, link_id: string;

		if (link.search(/[/:]track[/:](.+)/g) !== -1) {
			link_type = "track";
			link_id = /[/:]track[/:](.+)/g.exec(link)[1];
		} else if (link.search(/[/:]album[/:](.+)/g) !== -1) {
			link_type = "album";
			link_id = /[/:]album[/:](.+)/g.exec(link)[1];
		} else if (link.search(/[/:]playlist[/:](.+)/g) !== -1) {
			link_type = "playlist";
			link_id = /[/:]playlist[/:](.+)/g.exec(link)[1];
		}

		return [link, link_type, link_id];
	}

	override async generateDownloadObject(dz, link, bitrate) {
		let link_type, link_id;
		[link, link_type, link_id] = await this.parseLink(link);

		if (link_type == null || link_id == null) return null;

		switch (link_type) {
			case "track":
				return this.generateTrackItem(dz, link_id, bitrate);
			case "album":
				return this.generateAlbumItem(dz, link_id, bitrate);
			case "playlist":
				return this.generatePlaylistItem(dz, link_id, bitrate);
		}
	}

	async generateTrackItem(dz: Deezer, linkId: string, bitrate: number) {
		const cache = this.loadCache();

		let cachedTrack: CachedTrack;

		if (cache.tracks[linkId]) {
			cachedTrack = cache.tracks[linkId];
		} else {
			cachedTrack = await this.getTrack(linkId);
			cache.tracks[linkId] = cachedTrack;
			this.saveCache(cache);
		}

		if (cachedTrack.isrc) {
			try {
				return generateTrackItem(dz, `isrc:${cachedTrack.isrc}`, bitrate);
			} catch {
				/* empty */
			}
		}

		if (this.settings.fallbackSearch) {
			if (!cachedTrack.id || cachedTrack.id === 0) {
				const trackID = await dz.api.get_track_id_from_metadata(
					cachedTrack.data.artist,
					cachedTrack.data.title,
					cachedTrack.data.album
				);

				if (trackID !== "0") {
					cachedTrack.id = trackID;
					cache.tracks[linkId] = cachedTrack;
					this.saveCache(cache);
				}
			}
			if (cachedTrack.id !== 0)
				return generateTrackItem(dz, cachedTrack.id, bitrate);
		}

		throw new TrackNotOnDeezer(`https://open.spotify.com/track/${linkId}`);
	}

	async generateAlbumItem(dz: Deezer, link_id, bitrate) {
		const cache = this.loadCache();

		let cachedAlbum;
		if (cache.albums[link_id]) {
			cachedAlbum = cache.albums[link_id];
		} else {
			cachedAlbum = await this.getAlbum(link_id);
			cache.albums[link_id] = cachedAlbum;
			this.saveCache(cache);
		}

		try {
			return generateAlbumItem(dz, `upc:${cachedAlbum.upc}`, bitrate);
		} catch {
			throw new AlbumNotOnDeezer(`https://open.spotify.com/album/${link_id}`);
		}
	}

	async generatePlaylistItem(dz: Deezer, link_id: string, bitrate: number) {
		if (!this.enabled) throw new PluginNotEnabledError("Spotify");
		let spotifyPlaylist;
		let market: Market | undefined;
		try {
			spotifyPlaylist = await this.sp.playlists.getPlaylist(link_id);
		} catch (e) {
			// Some Spotify playlists require a market context to resolve.
			if (this.getSpotifyErrorStatus(e) === 404) {
				market = "US";
				try {
					spotifyPlaylist = await this.sp.playlists.getPlaylist(
						link_id,
						market
					);
				} catch (retryError) {
					if (this.getSpotifyErrorStatus(retryError) === 404) {
						return this.generatePlaylistItemFromPage(dz, link_id, bitrate);
					}
					throw retryError;
				}
			} else {
				throw e;
			}
		}

		const playlistAPI: any = this._convertPlaylistStructure(spotifyPlaylist);
		playlistAPI.various_artist = await dz.api.get_artist(5080); // Useful for save as compilation

		const tracklistTemp = await this.getPlaylistItems(link_id, market);

		const tracklist: SpotifyTrack[] = [];
		tracklistTemp.forEach((item) => {
			const track = item.track ?? item.item;
			if (!track || track.type !== "track") return;
			if (track.explicit && !playlistAPI.explicit) playlistAPI.explicit = true;
			tracklist.push(track);
		});
		if (!playlistAPI.explicit) playlistAPI.explicit = false;
		const syncData = this.createPlaylistSyncData(
			link_id,
			spotifyPlaylist,
			tracklist
		);
		playlistAPI.spotifySync = syncData;
		const tracksToDownload = this.filterAlreadyDownloadedTracks(
			link_id,
			tracklist
		);

		return new Convertable({
			type: "spotify_playlist",
			id: link_id,
			bitrate,
			title: spotifyPlaylist.name ?? `Spotify Playlist ${link_id}`,
			artist: spotifyPlaylist.owner?.display_name ?? "",
			cover: playlistAPI.picture_thumbnail,
			explicit: playlistAPI.explicit,
			size: tracksToDownload.length,
			collection: {
				tracks: [],
				playlistAPI,
			},
			plugin: "spotify",
			conversion_data: tracksToDownload,
		});
	}

	async getPlaylistItems(playlistId: string, market?: Market) {
		const getPlaylistItemsPage = (offset: number, limit: number) => {
			const params = new URLSearchParams({
				limit: limit.toString(),
				offset: offset.toString(),
				additional_types: "track",
			});

			if (market) params.set("market", market);

			return this.sp.makeRequest<any>(
				"GET",
				`playlists/${playlistId}/items?${params.toString()}`
			);
		};

		let playlistTracks = await getPlaylistItemsPage(0, 50);
		let tracklist = [...(playlistTracks.items ?? [])];

		while (playlistTracks.next) {
			const nextUrl = new URL(playlistTracks.next);
			const offset = parseInt(nextUrl.searchParams.get("offset") ?? "0");
			const limit = parseInt(nextUrl.searchParams.get("limit") ?? "50");

			playlistTracks = await getPlaylistItemsPage(offset, limit);
			tracklist = tracklist.concat(playlistTracks.items ?? []);
		}

		return tracklist;
	}

	async generatePlaylistItemFromPage(
		dz: Deezer,
		link_id: string,
		bitrate: number
	) {
		const playlistUrl = `https://open.spotify.com/playlist/${link_id}`;
		const page = await got.get(playlistUrl, {
			https: { rejectUnauthorized: false },
		});
		const html = page.body;

		const titleMatch = /<meta property="og:title" content="([^"]+)"/i.exec(
			html
		);
		const imageMatch = /<meta property="og:image" content="([^"]+)"/i.exec(
			html
		);
		const creatorMatch = /<meta name="music:creator" content="([^"]+)"/i.exec(
			html
		);
		const descriptionMatch = /<meta name="description" content="([^"]+)"/i.exec(
			html
		);
		const expectedCount = this.getExpectedPlaylistTrackCount(
			descriptionMatch?.[1] || ""
		);

		const webPlaylist = await this.getPlaylistFromWebApi(link_id);
		if (webPlaylist) {
			const playlistAPI: any = this._convertPlaylistStructure(
				webPlaylist.playlist
			);
			playlistAPI.various_artist = await dz.api.get_artist(5080);
			playlistAPI.explicit = webPlaylist.tracks.some((track) => track.explicit);
			const syncData = this.createPlaylistSyncData(
				link_id,
				webPlaylist.playlist,
				webPlaylist.tracks
			);
			playlistAPI.spotifySync = syncData;
			const tracksToDownload = this.filterAlreadyDownloadedTracks(
				link_id,
				webPlaylist.tracks
			);

			return new Convertable({
				type: "spotify_playlist",
				id: link_id,
				bitrate,
				title: webPlaylist.playlist.name,
				artist: webPlaylist.playlist.owner.display_name,
				cover: playlistAPI.picture_thumbnail,
				explicit: playlistAPI.explicit,
				size: tracksToDownload.length,
				collection: {
					tracks: [],
					playlistAPI,
				},
				plugin: "spotify",
				conversion_data: tracksToDownload,
			});
		}

		const trackIdSet = this.extractTrackIdsFromHtml(html);

		// Main playlist page often exposes only a preview subset (e.g. 30).
		if (expectedCount && trackIdSet.size < expectedCount) {
			try {
				const embedPage = await got.get(
					`https://open.spotify.com/embed/playlist/${link_id}`,
					{
						https: { rejectUnauthorized: false },
					}
				);
				const embedTrackIds = this.extractTrackIdsFromHtml(embedPage.body);
				for (const trackId of embedTrackIds) {
					trackIdSet.add(trackId);
				}
			} catch {
				/* empty */
			}
		}

		const trackIds = Array.from(trackIdSet);

		if (!trackIds.length) {
			throw new SpotifyPlaylistNotAccessible(playlistUrl);
		}

		const tracklist: SpotifyTrack[] = [];
		for (const trackId of trackIds) {
			try {
				const track = await this.sp.tracks.get(trackId);
				tracklist.push(track);
			} catch {
				// Skip tracks unavailable to this app credentials in current market
			}
		}

		if (!tracklist.length) {
			throw new SpotifyPlaylistNotAccessible(playlistUrl);
		}

		const ownerUrl =
			creatorMatch?.[1] || "https://open.spotify.com/user/spotify";
		const ownerId = ownerUrl.split("/").pop() || "spotify";
		const playlistLike: any = {
			snapshot_id: "",
			collaborative: false,
			owner: {
				id: ownerId,
				display_name: ownerId,
				href: ownerUrl,
			},
			description: descriptionMatch?.[1] || "",
			followers: { total: 0 },
			id: link_id,
			external_urls: { spotify: playlistUrl },
			tracks: {
				total: tracklist.length,
				href: `${playlistUrl}/tracks`,
			},
			images: imageMatch?.[1] ? [{ url: imageMatch[1] }] : [],
			public: true,
			name: titleMatch?.[1] || `Spotify Playlist ${link_id}`,
		};

		const playlistAPI: any = this._convertPlaylistStructure(playlistLike);
		playlistAPI.various_artist = await dz.api.get_artist(5080);
		playlistAPI.explicit = tracklist.some((track) => track.explicit);
		const syncData = this.createPlaylistSyncData(
			link_id,
			playlistLike,
			tracklist
		);
		playlistAPI.spotifySync = syncData;
		const tracksToDownload = this.filterAlreadyDownloadedTracks(
			link_id,
			tracklist
		);

		return new Convertable({
			type: "spotify_playlist",
			id: link_id,
			bitrate,
			title: playlistLike.name,
			artist: playlistLike.owner.display_name,
			cover: playlistAPI.picture_thumbnail,
			explicit: playlistAPI.explicit,
			size: tracksToDownload.length,
			collection: {
				tracks: [],
				playlistAPI,
			},
			plugin: "spotify",
			conversion_data: tracksToDownload,
		});
	}

	async getSpotifyWebAccessToken() {
		try {
			const data: any = await got
				.get(
					"https://open.spotify.com/get_access_token?reason=transport&productType=web_player",
					{
						https: { rejectUnauthorized: false },
						responseType: "json",
					}
				)
				.json();
			if (
				typeof data?.accessToken === "string" &&
				data.accessToken.length > 0
			) {
				return data.accessToken;
			}
		} catch {
			/* empty */
		}
		return null;
	}

	async getPlaylistFromWebApi(link_id: string) {
		const accessToken = await this.getSpotifyWebAccessToken();
		if (!accessToken) return null;

		const headers = {
			Authorization: `Bearer ${accessToken}`,
			accept: "application/json",
		};

		try {
			const playlist: any = await got
				.get(`https://api.spotify.com/v1/playlists/${link_id}?market=US`, {
					headers,
					https: { rejectUnauthorized: false },
					responseType: "json",
				})
				.json();

			const playlistItemsPage = playlist?.tracks ?? playlist?.items;
			const trackItems: any[] = Array.isArray(playlistItemsPage?.items)
				? [...playlistItemsPage.items]
				: [];
			let nextUrl: string | null = playlistItemsPage?.next || null;

			while (nextUrl) {
				const page: any = await got
					.get(nextUrl, {
						headers,
						https: { rejectUnauthorized: false },
						responseType: "json",
					})
					.json();
				if (Array.isArray(page?.items)) {
					trackItems.push(...page.items);
				}
				nextUrl = page?.next || null;
			}

			const tracklist: SpotifyTrack[] = [];
			for (const item of trackItems) {
				const track = item?.track ?? item?.item;
				if (!track || track.type !== "track" || typeof track.id !== "string")
					continue;
				tracklist.push(track);
			}

			if (!tracklist.length) return null;
			playlist.tracks = {
				...(playlistItemsPage ?? {}),
				items: trackItems,
				total: tracklist.length,
			};

			return {
				playlist,
				tracks: tracklist,
			};
		} catch {
			return null;
		}
	}

	extractTrackIdsFromHtml(html: string): Set<string> {
		const trackIdSet = new Set<string>();
		const addTrackIds = (matches: IterableIterator<RegExpMatchArray>) => {
			for (const match of matches) {
				if (match?.[1]) {
					trackIdSet.add(match[1]);
				}
			}
		};

		const nextDataMatch =
			/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
		if (nextDataMatch?.[1]) {
			addTrackIds(nextDataMatch[1].matchAll(/spotify:track:([A-Za-z0-9]+)/gi));
		}

		addTrackIds(
			html.matchAll(
				/<meta name="music:song" content="https:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]+)"/gi
			)
		);

		addTrackIds(html.matchAll(/spotify:track:([A-Za-z0-9]+)/gi));
		addTrackIds(html.matchAll(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/gi));

		return trackIdSet;
	}

	getExpectedPlaylistTrackCount(description: string): number | null {
		const countMatch = /(\d[\d,]*)\s+items?/i.exec(description);
		if (!countMatch?.[1]) return null;
		const parsedCount = Number.parseInt(countMatch[1].replaceAll(",", ""), 10);
		if (Number.isNaN(parsedCount) || parsedCount <= 0) return null;
		return parsedCount;
	}

	createSyncTrack(track: SpotifyTrack): SpotifySyncTrack {
		return {
			id: track.id,
			uri: track.uri,
			name: track.name,
			artists: (track.artists ?? []).map((artist) => artist.name),
			album: track.album?.name,
		};
	}

	createPlaylistSyncData(
		playlistId: string,
		spotifyPlaylist: any,
		tracklist: SpotifyTrack[]
	): SpotifyPlaylistSyncData {
		const downloadedTrackIds = this.getDownloadedSpotifyTrackIds(playlistId);
		const tracks: Record<string, SpotifySyncTrack> = {};
		const queuedTrackIds: string[] = [];
		const skippedTrackIds: string[] = [];

		for (const track of tracklist) {
			if (!track?.id) continue;
			tracks[track.id] = this.createSyncTrack(track);
			if (downloadedTrackIds.has(track.id)) skippedTrackIds.push(track.id);
			else queuedTrackIds.push(track.id);
		}

		return {
			playlistId,
			playlistName: spotifyPlaylist?.name ?? `Spotify Playlist ${playlistId}`,
			owner: spotifyPlaylist?.owner?.display_name,
			snapshotId: spotifyPlaylist?.snapshot_id,
			totalTracks: tracklist.length,
			queuedTrackIds,
			skippedTrackIds,
			tracks,
		};
	}

	filterAlreadyDownloadedTracks(
		playlistId: string,
		tracklist: SpotifyTrack[]
	): SpotifyTrack[] {
		const downloadedTrackIds = this.getDownloadedSpotifyTrackIds(playlistId);
		if (!downloadedTrackIds.size) return tracklist;
		return tracklist.filter((track) => !downloadedTrackIds.has(track.id));
	}

	getDownloadedSpotifyTrackIds(playlistId: string): Set<string> {
		const history = this.loadDownloadHistory();
		const playlist = history.playlists[playlistId];
		if (!playlist) return new Set();
		return new Set(Object.keys(playlist.tracks));
	}

	getPlaylistDownloadStatus(
		playlistId: string,
		totalTracks?: number
	): SpotifyDownloadStatus {
		const history = this.loadDownloadHistory();
		const playlist = history.playlists[playlistId];
		const knownTotal = totalTracks ?? playlist?.totalTracks ?? 0;
		const downloadedCount = playlist ? Object.keys(playlist.tracks).length : 0;

		return {
			downloaded: downloadedCount > 0,
			mirrored: knownTotal > 0 && downloadedCount >= knownTotal,
			downloadedCount,
			totalTracks: knownTotal,
			lastDownloadedAt: playlist?.lastDownloadedAt,
		};
	}

	getSpotifyTrackDownloadStatus(
		playlistId: string,
		trackId: string
	):
		| (SpotifyDownloadHistoryTrack & { downloaded: true })
		| { downloaded: false } {
		const history = this.loadDownloadHistory();
		const track = history.playlists[playlistId]?.tracks?.[trackId];
		if (!track) return { downloaded: false };
		return {
			...track,
			downloaded: true,
		};
	}

	applyPlaylistDownloadStatus(playlist: any) {
		if (!playlist?.id) return playlist;
		const totalTracks =
			playlist.nb_tracks ??
			playlist.tracks?.total ??
			(Array.isArray(playlist.tracks) ? playlist.tracks.length : undefined);
		playlist.spotifyDownloadStatus = this.getPlaylistDownloadStatus(
			playlist.id,
			totalTracks
		);
		return playlist;
	}

	applyTrackDownloadStatus(playlistId: string, track: any) {
		if (!track?.id) return track;
		track.spotifyDownloadStatus = this.getSpotifyTrackDownloadStatus(
			playlistId,
			track.id
		);
		return track;
	}

	loadDownloadHistory(): SpotifyDownloadHistory {
		try {
			const history = JSON.parse(
				fs.readFileSync(this.getDownloadHistoryPath()).toString()
			);
			if (history?.version === 1 && history?.playlists) {
				return history;
			}
		} catch {
			/* empty */
		}

		return {
			version: 1,
			playlists: {},
		};
	}

	saveDownloadHistory(history: SpotifyDownloadHistory) {
		fs.mkdirSync(this.configFolder, { recursive: true });
		fs.writeFileSync(
			this.getDownloadHistoryPath(),
			JSON.stringify(history, null, 2)
		);
	}

	recordPlaylistDownload(downloadObject: Collection) {
		if (downloadObject.type !== "spotify_playlist") return;

		const spotifySync = downloadObject.collection?.playlistAPI?.spotifySync as
			| SpotifyPlaylistSyncData
			| undefined;
		if (!spotifySync?.playlistId) return;

		const history = this.loadDownloadHistory();
		const now = new Date().toISOString();
		const playlist: SpotifyDownloadHistoryPlaylist = {
			id: spotifySync.playlistId,
			name: spotifySync.playlistName,
			owner: spotifySync.owner,
			snapshotId: spotifySync.snapshotId,
			totalTracks: spotifySync.totalTracks,
			lastSeenAt: now,
			lastDownloadedAt:
				history.playlists[spotifySync.playlistId]?.lastDownloadedAt,
			downloadedCount: 0,
			tracks: history.playlists[spotifySync.playlistId]?.tracks ?? {},
		};

		const downloadedFilesByDeezerId = new Map<string, any>();
		for (const file of downloadObject.files ?? []) {
			const deezerId = file?.data?.id;
			if (deezerId === undefined || deezerId === null) continue;
			downloadedFilesByDeezerId.set(String(deezerId), file);
		}

		let successfulTracks = 0;
		for (const trackAPI of downloadObject.collection?.tracks ?? []) {
			const spotifyTrack = (trackAPI as any)?.spotifySync as
				| SpotifySyncTrack
				| undefined;
			if (!spotifyTrack?.id) continue;

			const deezerId = String((trackAPI as any)?.id ?? "");
			const downloadedFile = downloadedFilesByDeezerId.get(deezerId);
			if (!downloadedFile) continue;

			const existingTrack = playlist.tracks[spotifyTrack.id];
			playlist.tracks[spotifyTrack.id] = {
				id: spotifyTrack.id,
				uri: spotifyTrack.uri ?? existingTrack?.uri,
				name: spotifyTrack.name,
				artists: spotifyTrack.artists,
				album: spotifyTrack.album,
				deezerId,
				deezerTitle: (trackAPI as any)?.title,
				path: downloadedFile.path,
				firstDownloadedAt: existingTrack?.firstDownloadedAt ?? now,
				lastDownloadedAt: now,
			};
			successfulTracks += 1;
		}

		if (successfulTracks > 0) playlist.lastDownloadedAt = now;
		playlist.downloadedCount = Object.keys(playlist.tracks).length;
		history.playlists[spotifySync.playlistId] = playlist;
		this.saveDownloadHistory(history);
	}

	getDownloadHistoryPath() {
		return this.configFolder + "download-history.json";
	}

	getSpotifyErrorStatus(error: any): number | undefined {
		const directStatus =
			error?.status ??
			error?.response?.statusCode ??
			error?.body?.error?.status ??
			error?.statusCode;
		if (typeof directStatus === "number") return directStatus;

		const message = String(error?.message || "");
		const codeMatch =
			/message:\s*(\d+)/i.exec(message) ||
			/response code:\s*(\d+)/i.exec(message) ||
			/"status"\s*:\s*(\d+)/i.exec(message);
		if (codeMatch?.[1]) return Number.parseInt(codeMatch[1], 10);

		return undefined;
	}

	async getTrack(track_id: string, spotifyTrack?: SpotifyTrack) {
		if (!this.enabled) throw new PluginNotEnabledError("Spotify");

		const cachedTrack = {
			isrc: null,
			data: null,
		};

		if (!spotifyTrack) {
			try {
				spotifyTrack = await this.sp.tracks.get(track_id);
			} catch (e) {
				if (e.body.error.message === "invalid id")
					throw new InvalidID(`https://open.spotify.com/track/${track_id}`);
				throw e;
			}
		}

		if (spotifyTrack.external_ids && spotifyTrack.external_ids.isrc) {
			let isrc = spotifyTrack.external_ids.isrc;
			if (isrc.includes("-")) {
				isrc = isrc.replace("-", "");
			}

			cachedTrack.isrc = isrc;
		}

		cachedTrack.data = {
			title: spotifyTrack.name,
			artist: spotifyTrack.artists[0].name,
			album: spotifyTrack.album.name,
		};

		return cachedTrack;
	}

	async getAlbum(album_id: string, spotifyAlbum = null) {
		if (!this.enabled) throw new PluginNotEnabledError("Spotify");
		const cachedAlbum = {
			upc: null,
			data: null,
		};

		if (!spotifyAlbum) {
			try {
				spotifyAlbum = await this.sp.albums.get(album_id);
			} catch (e) {
				if (e.body.error.message === "invalid id")
					throw new InvalidID(`https://open.spotify.com/album/${album_id}`);
				throw e;
			}
		}
		if (spotifyAlbum.external_ids && spotifyAlbum.external_ids.upc)
			cachedAlbum.upc = spotifyAlbum.external_ids.upc;
		cachedAlbum.data = {
			title: spotifyAlbum.name,
			artist: spotifyAlbum.artists[0].name,
		};
		return cachedAlbum;
	}

	async convert(
		dz: Deezer,
		downloadObject: Convertable,
		settings: Settings,
		listener: any = null
	): Promise<Collection> {
		const cache = this.loadCache();

		let conversion = 0;
		let conversionNext = 0;

		const collection = [];
		if (listener)
			listener.send("startConversion", {
				uuid: downloadObject.uuid,
				title: downloadObject.title,
			});

		const q = queue(
			async (data: { track: SpotifyTrack; pos: number }, callback) => {
				const { track, pos } = data;
				if (downloadObject.isCanceled) return;

				let cachedTrack;
				if (cache.tracks[track.id]) {
					cachedTrack = cache.tracks[track.id];
				} else {
					cachedTrack = await this.getTrack(track.id, track);
					cache.tracks[track.id] = cachedTrack;
					this.saveCache(cache);
				}

				let trackAPI: DeezerTrack;
				if (cachedTrack.isrc) {
					try {
						trackAPI = await dz.api.getTrackByISRC(cachedTrack.isrc);
						if (!trackAPI.id || !trackAPI.title) trackAPI = null;
					} catch {
						/* Empty */
					}
				}

				if (this.settings.fallbackSearch && !trackAPI) {
					if (!cachedTrack.id || cachedTrack.id === "0") {
						const trackID = await dz.api.get_track_id_from_metadata(
							cachedTrack.data.artist,
							cachedTrack.data.title,
							cachedTrack.data.album
						);
						if (trackID !== "0") {
							cachedTrack.id = trackID;
							cache.tracks[track.id] = cachedTrack;
							this.saveCache(cache);
						}
					}
					if (cachedTrack.id !== "0")
						trackAPI = await dz.api.getTrack(cachedTrack.id);
				}

				if (!trackAPI) {
					trackAPI = {
						id: "0",
						title: track.name,
						duration: 0,
						md5_origin: 0,
						media_version: 0,
						filesizes: {},
						album: {
							title: track.album.name,
							md5_image: "",
						},
						artist: {
							id: 0,
							name: track.artists[0].name,
							md5_image: "",
						},
					};
				}

				trackAPI.position = pos + 1;
				(trackAPI as any).spotifySync = this.createSyncTrack(track);
				collection[pos] = trackAPI;

				conversionNext +=
					downloadObject.size > 0 ? (1 / downloadObject.size) * 100 : 0;

				if (
					Math.round(conversionNext) !== conversion &&
					Math.round(conversionNext) % 10 === 0 &&
					Math.round(conversionNext) !== 100
				) {
					conversion = Math.round(conversionNext);
					if (listener)
						listener.send("updateQueue", {
							uuid: downloadObject.uuid,
							title: downloadObject.title,
							conversion,
						});
				}

				callback();
			},
			settings.queueConcurrency
		);

		downloadObject.conversionData.forEach((track, pos) => {
			q.push({ track, pos }, () => {});
		});

		await q.drain();

		downloadObject.collection.tracks = collection;
		downloadObject.size = collection.length;

		const returnCollection = new Collection(downloadObject.toDict());
		if (listener)
			listener.send("finishConversion", returnCollection.getSlimmedDict());

		fs.writeFileSync(this.configFolder + "cache.json", JSON.stringify(cache));
		return returnCollection;
	}

	_convertPlaylistStructure(spotifyPlaylist) {
		let cover = null;
		// Mickey: some playlists can be faulty, for example https://open.spotify.com/playlist/7vyEjAGrXOIjqlC8pZRupW
		if (spotifyPlaylist?.images?.length) cover = spotifyPlaylist.images[0].url;
		const playlistId = spotifyPlaylist.id;
		const owner = spotifyPlaylist.owner ?? {};
		const tracks = spotifyPlaylist.tracks ?? spotifyPlaylist.items ?? {};
		const spotifyUrl =
			spotifyPlaylist.external_urls?.spotify ??
			`https://open.spotify.com/playlist/${playlistId}`;

		const deezerPlaylist = {
			checksum: spotifyPlaylist.snapshot_id ?? playlistId,
			collaborative: !!spotifyPlaylist.collaborative,
			creation_date: "XXXX-00-00",
			creator: {
				id: owner.id ?? "",
				name: owner.display_name ?? "",
				tracklist:
					owner.href ??
					(owner.id ? `https://api.spotify.com/v1/users/${owner.id}` : ""),
				type: "user",
			},
			description: spotifyPlaylist.description ?? "",
			duration: 0,
			fans: spotifyPlaylist.followers ? spotifyPlaylist.followers.total : 0,
			id: playlistId,
			is_loved_track: false,
			link: spotifyUrl,
			nb_tracks: tracks.total ?? 0,
			picture: cover,
			picture_small:
				cover ||
				"https://e-cdns-images.dzcdn.net/images/cover/d41d8cd98f00b204e9800998ecf8427e/56x56-000000-80-0-0.jpg",
			picture_medium:
				cover ||
				"https://e-cdns-images.dzcdn.net/images/cover/d41d8cd98f00b204e9800998ecf8427e/250x250-000000-80-0-0.jpg",
			picture_big:
				cover ||
				"https://e-cdns-images.dzcdn.net/images/cover/d41d8cd98f00b204e9800998ecf8427e/500x500-000000-80-0-0.jpg",
			picture_xl:
				cover ||
				"https://e-cdns-images.dzcdn.net/images/cover/d41d8cd98f00b204e9800998ecf8427e/1000x1000-000000-80-0-0.jpg",
			picture_thumbnail:
				cover ||
				"https://e-cdns-images.dzcdn.net/images/cover/d41d8cd98f00b204e9800998ecf8427e/75x75-000000-80-0-0.jpg",
			public: spotifyPlaylist.public ?? false,
			share: spotifyUrl,
			title: spotifyPlaylist.name ?? "",
			tracklist: tracks.href ?? "",
			type: "playlist",
		};

		return deezerPlaylist;
	}

	loadSettings() {
		if (!fs.existsSync(this.configFolder + "config.json")) {
			fs.writeFileSync(
				this.configFolder + "config.json",
				JSON.stringify(
					{
						...this.credentials,
						...this.settings,
					},
					null,
					2
				)
			);
		}
		let settings;
		try {
			settings = JSON.parse(
				fs.readFileSync(this.configFolder + "config.json").toString()
			);
		} catch (e) {
			if (e.name === "SyntaxError") {
				fs.writeFileSync(
					this.configFolder + "config.json",
					JSON.stringify(
						{
							...this.credentials,
							...this.settings,
						},
						null,
						2
					)
				);
			}
			settings = JSON.parse(
				JSON.stringify({
					...this.credentials,
					...this.settings,
				})
			);
		}
		this.setSettings(settings);
		this.checkCredentials();
	}

	saveSettings(newSettings?: any) {
		if (newSettings) this.setSettings(newSettings);
		this.checkCredentials();
		fs.writeFileSync(
			this.configFolder + "config.json",
			JSON.stringify(
				{
					...this.credentials,
					...this.settings,
				},
				null,
				2
			)
		);
	}

	getSettings() {
		return {
			...this.credentials,
			...this.settings,
		};
	}

	setSettings(newSettings) {
		const nextClientId = (newSettings.clientId ?? "").trim();
		const nextClientSecret = (newSettings.clientSecret ?? "").trim();
		const credentialsChanged =
			nextClientId !== this.credentials.clientId ||
			nextClientSecret !== this.credentials.clientSecret;
		const previousAccessToken = credentialsChanged
			? undefined
			: this.settings.accessToken;
		const previousUser = credentialsChanged ? undefined : this.settings.user;

		this.credentials = {
			clientId: nextClientId,
			clientSecret: nextClientSecret,
		};
		const settings = { ...newSettings };
		delete settings.clientId;
		delete settings.clientSecret;
		this.settings = {
			fallbackSearch: !!settings.fallbackSearch,
			accessToken: settings.accessToken ?? previousAccessToken,
			user: settings.user ?? previousUser,
		};
	}

	loadCache() {
		let cache;
		try {
			cache = JSON.parse(
				fs.readFileSync(this.configFolder + "cache.json").toString()
			);
		} catch (e) {
			if (e.name === "SyntaxError") {
				fs.writeFileSync(
					this.configFolder + "cache.json",
					JSON.stringify({ tracks: {}, albums: {} }, null, 2)
				);
			}
			cache = { tracks: {}, albums: {} };
		}
		return cache;
	}

	saveCache(newCache) {
		fs.writeFileSync(
			this.configFolder + "cache.json",
			JSON.stringify(newCache)
		);
	}

	checkCredentials() {
		if (
			this.credentials.clientId === "" ||
			this.credentials.clientSecret === "" ||
			!this.settings.accessToken?.access_token ||
			!this.settings.accessToken?.refresh_token
		) {
			this.enabled = false;
			return;
		}

		this.sp = new SpotifyApi(
			new StoredSpotifyAccessTokenStrategy(
				this.credentials.clientId,
				this.settings.accessToken,
				async (clientId, token) => {
					const refreshedToken = await this.refreshAccessToken(clientId, token);
					this.settings.accessToken = refreshedToken;
					this.saveSettings();
					return refreshedToken;
				}
			)
		);
		this.enabled = true;
	}

	createAuthorizationState(redirectUri: string) {
		const state = randomBytes(16).toString("hex");
		this.authorizationStates.set(state, { createdAt: Date.now(), redirectUri });
		return state;
	}

	consumeAuthorizationState(state: string) {
		this.clearExpiredAuthorizationStates();
		const authorizationState = this.authorizationStates.get(state);
		if (!authorizationState) return null;
		this.authorizationStates.delete(state);
		return authorizationState.redirectUri;
	}

	getRedirectUri(port: string | number) {
		return `http://127.0.0.1:${port}/spotify/callback`;
	}

	getAuthorizationUrl(redirectUri: string, state: string) {
		const params = new URLSearchParams({
			client_id: this.credentials.clientId,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: "playlist-read-private playlist-read-collaborative",
			state,
		});

		return `https://accounts.spotify.com/authorize?${params.toString()}`;
	}

	async completeAuthorization(code: string, redirectUri: string) {
		const token = await this.exchangeAuthorizationCode(code, redirectUri);
		this.settings.accessToken = token;
		this.checkCredentials();
		const userProfile = await this.sp.currentUser.profile();
		this.settings.user = {
			id: userProfile.id,
			name: userProfile.display_name,
			picture: userProfile.images?.[0]?.url ?? null,
		};
		this.saveSettings();
		return this.settings.user;
	}

	getUser() {
		return this.settings.user ?? null;
	}

	async getCurrentUserPlaylistsFromWebApi() {
		return this.getPagedSpotifyItems(
			"https://api.spotify.com/v1/me/playlists?limit=50"
		);
	}

	async getUserPlaylistsFromWebApi(userId: string) {
		return this.getPagedSpotifyItems(
			`https://api.spotify.com/v1/users/${userId}/playlists?limit=50`
		);
	}

	async getPlaylistDetailsFromWebApi(playlistId: string) {
		return this.getSpotifyJson<any>(
			`https://api.spotify.com/v1/playlists/${playlistId}`
		);
	}

	private async getPagedSpotifyItems(firstUrl: string) {
		const items: any[] = [];
		let nextUrl: string | null = firstUrl;

		while (nextUrl) {
			const page = await this.getSpotifyJson<any>(nextUrl);
			items.push(...(page?.items ?? []));
			nextUrl = page?.next ?? null;
		}

		return items;
	}

	private async getSpotifyJson<T>(url: string) {
		const accessToken = await this.getValidAccessToken();
		return got
			.get(url, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
				https: { rejectUnauthorized: false },
				responseType: "json",
				timeout: { request: 10000 },
			})
			.json<T>();
	}

	private async getValidAccessToken() {
		if (!this.settings.accessToken?.access_token) {
			throw new PluginNotEnabledError("Spotify");
		}

		const expiresAt = this.settings.accessToken.expires ?? 0;
		const expiresSoon = expiresAt <= Date.now() + 60 * 1000;
		if (expiresSoon) {
			this.settings.accessToken = await this.refreshAccessToken(
				this.credentials.clientId,
				this.settings.accessToken
			);
			this.saveSettings();
		}

		return this.settings.accessToken.access_token;
	}

	private async exchangeAuthorizationCode(code: string, redirectUri: string) {
		const token = await got
			.post("https://accounts.spotify.com/api/token", {
				form: {
					grant_type: "authorization_code",
					code,
					redirect_uri: redirectUri,
				},
				headers: this.getAuthorizationHeaders(),
			})
			.json<AccessToken>();

		return this.normalizeAccessToken(token);
	}

	private async refreshAccessToken(_clientId: string, token: AccessToken) {
		const refreshedToken = await got
			.post("https://accounts.spotify.com/api/token", {
				form: {
					grant_type: "refresh_token",
					refresh_token: token.refresh_token,
				},
				headers: this.getAuthorizationHeaders(),
			})
			.json<AccessToken>();

		return this.normalizeAccessToken({
			...refreshedToken,
			refresh_token: refreshedToken.refresh_token ?? token.refresh_token,
		});
	}

	private normalizeAccessToken(token: AccessToken): AccessToken {
		return {
			...token,
			expires: Date.now() + token.expires_in * 1000,
		};
	}

	private getAuthorizationHeaders() {
		const credentials = Buffer.from(
			`${this.credentials.clientId}:${this.credentials.clientSecret}`
		).toString("base64");

		return {
			Authorization: `Basic ${credentials}`,
		};
	}

	private clearExpiredAuthorizationStates() {
		const expiresAt = Date.now() - 10 * 60 * 1000;
		this.authorizationStates.forEach((authorizationState, state) => {
			if (authorizationState.createdAt < expiresAt) {
				this.authorizationStates.delete(state);
			}
		});
	}

	getCredentials() {
		return this.credentials;
	}

	setCredentials(clientId, clientSecret) {
		clientId = clientId.trim();
		clientSecret = clientSecret.trim();

		this.credentials = { clientId, clientSecret };
		this.saveSettings();
	}
}
