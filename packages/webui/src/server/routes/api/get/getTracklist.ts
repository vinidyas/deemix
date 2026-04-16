import { Deezer, utils as dzUtils } from "deezer-sdk";
import { type ApiHandler } from "../../../types.js";
import { sessionDZ } from "../../../deemixApp.js";

const path: ApiHandler["path"] = "/getTracklist";

const handler: ApiHandler["handler"] = async (req, res) => {
	if (!sessionDZ[req.session.id]) sessionDZ[req.session.id] = new Deezer();
	const dz = sessionDZ[req.session.id];
	const deemix = req.app.get("deemix");

	const list_id = String(req.query.id);
	const list_type = String(req.query.type);
	switch (list_type) {
		case "artist": {
			const artistAPI = await dz.api.get_artist(list_id);
			(artistAPI as any).releases = await dz.gw.get_artist_discography_tabs(
				list_id,
				{
					limit: 100,
				}
			);
			res.send(artistAPI);
			break;
		}
		case "spotifyplaylist":
		case "spotify_playlist": {
			if (!deemix.plugins.spotify.enabled) {
				res.send({
					collaborative: false,
					description: "",
					external_urls: { spotify: null },
					followers: { total: 0, href: null },
					id: null,
					images: [],
					name: "Something went wrong",
					owner: {
						display_name: "Error",
						id: null,
					},
					public: true,
					tracks: [],
					type: "playlist",
					uri: null,
				});
				break;
			}
			const sp = deemix.plugins.spotify.sp;
			try {
				const playlist = await sp.playlists.getPlaylist(list_id);
				const tracklist =
					await deemix.plugins.spotify.getPlaylistItems(list_id);
				playlist.tracks = tracklist
					.map((item: any) => item.track ?? item.item)
					.filter(Boolean)
					.map((track: any) => {
						track.selected = false;
						return deemix.plugins.spotify.applyTrackDownloadStatus(
							list_id,
							track
						);
					});
				deemix.plugins.spotify.applyPlaylistDownloadStatus(playlist);
				res.send(playlist);
			} catch {
				const webPlaylist =
					await deemix.plugins.spotify.getPlaylistFromWebApi(list_id);
				if (webPlaylist) {
					webPlaylist.playlist.tracks = webPlaylist.tracks.map((track) => {
						track.selected = false;
						return deemix.plugins.spotify.applyTrackDownloadStatus(
							list_id,
							track
						);
					});
					deemix.plugins.spotify.applyPlaylistDownloadStatus(
						webPlaylist.playlist
					);
					res.send(webPlaylist.playlist);
					break;
				}

				res.send({
					collaborative: false,
					description: "",
					external_urls: {
						spotify: `https://open.spotify.com/playlist/${list_id}`,
					},
					followers: { total: 0, href: null },
					id: list_id,
					images: [],
					name: "Spotify playlist is not accessible",
					owner: {
						display_name: "Spotify",
						id: null,
					},
					public: false,
					tracks: [],
					type: "playlist",
					uri: null,
				});
			}
			break;
		}
		default: {
			let releaseAPI, releaseTracksAPI;
			try {
				releaseAPI = await dz.api[`get_${list_type}`](list_id);
				releaseTracksAPI = await dz.api[`get_${list_type}_tracks`](list_id);
				releaseTracksAPI = releaseTracksAPI.data;
			} catch {
				if (list_type === "playlist") {
					releaseAPI = dzUtils.map_playlist(
						await (
							await dz.gw.get_playlist_page(list_id)
						).DATA
					);
					releaseTracksAPI = await dz.gw.get_playlist_tracks(list_id);
				} else {
					releaseAPI = {};
					releaseTracksAPI = [];
				}
			}

			const tracks: any[] = [];
			const showdiscs =
				list_type === "album" &&
				releaseTracksAPI.length &&
				releaseTracksAPI[releaseTracksAPI.length - 1].disk_number !== 1;
			let current_disk = 0;

			releaseTracksAPI.forEach((track: any) => {
				if (track.SNG_ID) track = dzUtils.mapGwTrackToDeezer(track);
				if (showdiscs && parseInt(track.disk_number) !== current_disk) {
					current_disk = parseInt(track.disk_number);
					tracks.push({ type: "disc_separator", number: current_disk });
				}
				track.selected = false;
				tracks.push(track);
			});
			releaseAPI.tracks = tracks;
			res.send(releaseAPI);
			break;
		}
	}
};

const apiHandler: ApiHandler = { path, handler };

export default apiHandler;
