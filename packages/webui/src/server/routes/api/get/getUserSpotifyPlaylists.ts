import { logger } from "../../../helpers/logger.js";
import { type ApiHandler } from "../../../types.js";

const path: ApiHandler["path"] = "/getUserSpotifyPlaylists";

const handler: ApiHandler["handler"] = async (req, res) => {
	let data;
	const deemix = req.app.get("deemix");

	if (deemix.plugins.spotify.enabled) {
		logger.info("Refreshing Spotify playlists");
		data = [];
		let playlistList: any[] = [];

		try {
			try {
				playlistList =
					await deemix.plugins.spotify.getCurrentUserPlaylistsFromWebApi();
			} catch (currentUserError) {
				const spotifyUser = deemix.plugins.spotify.getUser();
				if (!spotifyUser?.id) throw currentUserError;
				logger.info("Falling back to Spotify user playlists endpoint");
				playlistList = await deemix.plugins.spotify.getUserPlaylistsFromWebApi(
					spotifyUser.id
				);
			}
		} catch (error) {
			logger.error(error);
			res.send({ error: "spotifyPlaylistsUnavailable" });
			return;
		}
		logger.info(`Spotify playlists loaded: ${playlistList.length}`);
		for (const playlist of playlistList) {
			data.push(
				deemix.plugins.spotify.applyPlaylistDownloadStatus(
					deemix.plugins.spotify._convertPlaylistStructure(playlist)
				)
			);
		}
	} else {
		data = { error: "spotifyNotEnabled" };
	}
	res.send(data);
};

const apiHandler: ApiHandler = { path, handler };

export default apiHandler;
