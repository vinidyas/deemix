import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve, sep } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Collection } from "@/download-objects/Collection.js";
import SpotifyPlugin from "./spotify.js";

const { gotGetMock } = vi.hoisted(() => ({ gotGetMock: vi.fn() }));

vi.mock("got", () => {
	return {
		default: {
			get: gotGetMock,
		},
	};
});

const tempFolders: string[] = [];

function createTempPlugin() {
	const tempFolder = mkdtempSync(`${tmpdir()}${sep}deemix-spotify-test-`);
	tempFolders.push(tempFolder);
	return new SpotifyPlugin(`${tempFolder}${sep}`).setup();
}

function setDownloadLocation(plugin: SpotifyPlugin, downloadLocation: string) {
	mkdirSync(downloadLocation, { recursive: true });
	writeFileSync(
		resolve(plugin.configFolder, "..", "config.json"),
		JSON.stringify({ downloadLocation }, null, 2)
	);
}

function createSpotifyTrack(id: string, name: string) {
	return {
		id,
		uri: `spotify:track:${id}`,
		type: "track",
		explicit: false,
		name,
		artists: [{ name: "Artist" }],
		album: { name: "Album" },
	} as any;
}

afterEach(() => {
	gotGetMock.mockReset();
	while (tempFolders.length) {
		const tempFolder = tempFolders.pop();
		if (tempFolder) rmSync(tempFolder, { recursive: true, force: true });
	}
});

describe("SpotifyPlugin playlist fallback", () => {
	it("uses embed page IDs when playlist page only has preview items", async () => {
		const mainHtml = `
			<html>
				<head>
					<meta property="og:title" content="70s Rock Drive" />
					<meta property="og:image" content="https://img.test/cover.jpg" />
					<meta name="music:creator" content="https://open.spotify.com/user/spotify" />
					<meta name="description" content="Playlist · Spotify · 3 items" />
					<meta name="music:song" content="https://open.spotify.com/track/TRACK001" />
					<meta name="music:song" content="https://open.spotify.com/track/TRACK002" />
				</head>
			</html>
		`;

		// Embed page has all IDs, including TRACK003 missing from main HTML.
		const embedHtml = `
			<html>
				<body>
					<script>
						window.__EMBED_STATE__ = {
							tracks: [
								"spotify:track:TRACK001",
								"spotify:track:TRACK002",
								"spotify:track:TRACK003"
							]
						};
					</script>
				</body>
			</html>
		`;

		gotGetMock.mockImplementation(async (url: string) => {
			if (url.includes("/embed/playlist/")) return { body: embedHtml };
			return { body: mainHtml };
		});

		const plugin = createTempPlugin();
		plugin.getPlaylistFromWebApi = vi.fn().mockResolvedValue(null);
		plugin.sp = {
			tracks: {
				get: vi.fn(async (id: string) => createSpotifyTrack(id, `Track ${id}`)),
			},
		} as any;
		plugin.enabled = true;

		const dz = {
			api: {
				get_artist: vi.fn(async () => ({ id: 5080, name: "Various Artists" })),
			},
		} as any;

		const result = await plugin.generatePlaylistItemFromPage(dz, "test", 1);
		const ids = result.conversionData.map((track) => track.id).sort();

		expect(result.size).toBe(3);
		expect(ids).toEqual(["TRACK001", "TRACK002", "TRACK003"]);
		expect(gotGetMock).toHaveBeenCalledWith(
			expect.stringContaining("/embed/playlist/"),
			expect.any(Object)
		);
	});
});

describe("SpotifyPlugin download history", () => {
	it("records successful playlist downloads and skips them next time", () => {
		const plugin = createTempPlugin();
		const downloadLocation = resolve(plugin.configFolder, "..", "music");
		const downloadedPath = `${downloadLocation}${sep}downloaded.mp3`;
		setDownloadLocation(plugin, downloadLocation);
		writeFileSync(downloadedPath, "");

		const downloadedTrack = createSpotifyTrack("SPOTIFY001", "Downloaded");
		const failedTrack = createSpotifyTrack("SPOTIFY002", "Failed");
		const syncData = plugin.createPlaylistSyncData(
			"playlist-1",
			{
				name: "Sync Playlist",
				owner: { display_name: "Vinicius" },
				snapshot_id: "snapshot-1",
			},
			[downloadedTrack, failedTrack]
		);

		const downloadObject = new Collection({
			type: "spotify_playlist",
			id: "playlist-1",
			bitrate: 3,
			title: "Sync Playlist",
			artist: "Vinicius",
			cover: "",
			size: 2,
			downloaded: 1,
			failed: 1,
			files: [{ data: { id: 123 }, path: downloadedPath }],
			collection: {
				playlistAPI: { spotifySync: syncData },
				tracks: [
					{
						id: 123,
						title: "Downloaded Deezer Track",
						artist: { name: "Artist" },
						spotifySync: syncData.tracks.SPOTIFY001,
					},
					{
						id: "0",
						title: "Failed Deezer Track",
						artist: { name: "Artist" },
						spotifySync: syncData.tracks.SPOTIFY002,
					},
				],
			},
		});

		plugin.recordPlaylistDownload(downloadObject);

		const history = plugin.loadDownloadHistory();
		expect(history.playlists["playlist-1"].downloadedCount).toBe(1);
		expect(history.playlists["playlist-1"].tracks.SPOTIFY001.path).toBe(
			downloadedPath
		);
		expect(history.playlists["playlist-1"].tracks.SPOTIFY002).toBeUndefined();

		const nextTracks = plugin.filterAlreadyDownloadedTracks("playlist-1", [
			downloadedTrack,
			failedTrack,
		]);
		expect(nextTracks.map((track) => track.id)).toEqual(["SPOTIFY002"]);

		const nextSyncData = plugin.createPlaylistSyncData(
			"playlist-1",
			{ name: "Sync Playlist" },
			[downloadedTrack, failedTrack]
		);
		expect(nextSyncData.skippedTrackIds).toEqual(["SPOTIFY001"]);
		expect(nextSyncData.queuedTrackIds).toEqual(["SPOTIFY002"]);
	});

	it("allows a playlist to be downloaded again when the destination changes", () => {
		const plugin = createTempPlugin();
		const oldDownloadLocation = resolve(plugin.configFolder, "..", "old-music");
		const newDownloadLocation = resolve(plugin.configFolder, "..", "new-music");
		const oldDownloadedPath = `${oldDownloadLocation}${sep}downloaded.mp3`;
		setDownloadLocation(plugin, oldDownloadLocation);
		writeFileSync(oldDownloadedPath, "");

		const downloadedTrack = createSpotifyTrack("SPOTIFY001", "Downloaded");
		const syncData = plugin.createPlaylistSyncData(
			"playlist-1",
			{ name: "Sync Playlist" },
			[downloadedTrack]
		);

		const downloadObject = new Collection({
			type: "spotify_playlist",
			id: "playlist-1",
			bitrate: 3,
			title: "Sync Playlist",
			artist: "Vinicius",
			cover: "",
			size: 1,
			downloaded: 1,
			failed: 0,
			files: [{ data: { id: 123 }, path: oldDownloadedPath }],
			collection: {
				playlistAPI: { spotifySync: syncData },
				tracks: [
					{
						id: 123,
						title: "Downloaded Deezer Track",
						artist: { name: "Artist" },
						spotifySync: syncData.tracks.SPOTIFY001,
					},
				],
			},
		});

		plugin.recordPlaylistDownload(downloadObject);
		expect(
			plugin.filterAlreadyDownloadedTracks("playlist-1", [downloadedTrack])
		).toEqual([]);
		expect(plugin.getPlaylistDownloadStatus("playlist-1", 1)).toMatchObject({
			downloaded: true,
			mirrored: true,
			downloadedCount: 1,
		});

		setDownloadLocation(plugin, newDownloadLocation);
		expect(
			plugin
				.filterAlreadyDownloadedTracks("playlist-1", [downloadedTrack])
				.map((track) => track.id)
		).toEqual(["SPOTIFY001"]);
		expect(plugin.getPlaylistDownloadStatus("playlist-1", 1)).toMatchObject({
			downloaded: false,
			mirrored: false,
			downloadedCount: 0,
		});
		expect(
			plugin.getSpotifyTrackDownloadStatus("playlist-1", "SPOTIFY001")
		).toEqual({ downloaded: false });
	});
});
