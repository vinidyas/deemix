import i18n from "@/plugins/i18n";
import { pinia } from "@/stores";
import { useLoginStore } from "@/stores/login";
import { fetchData } from "@/utils/api-utils";
import { toast } from "@/utils/toasts";
import { ref } from "vue";

const loginStore = useLoginStore(pinia);

const favoriteArtists = ref([]);
const favoriteAlbums = ref([]);
const favoriteSpotifyPlaylists = ref([]);
const favoritePlaylists = ref([]);
const favoriteTracks = ref([]);
const lovedTracksPlaylist = ref("");

const isRefreshingFavorites = ref(false);
let refreshPromise: Promise<void> | null = null;
const FAVORITES_REFRESH_TIMEOUT = 20000;
const SPOTIFY_STATUS_TIMEOUT = 8000;

const withTimeout = <T>(
	promise: Promise<T>,
	timeout: number,
	errorMessage: string
) => {
	let timeoutId: ReturnType<typeof setTimeout>;

	const timeoutPromise = new Promise<T>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error(errorMessage));
		}, timeout);
	});

	return Promise.race([promise, timeoutPromise]).finally(() => {
		clearTimeout(timeoutId);
	});
};

const setAllFavorites = (data) => {
	const { tracks, albums, artists, playlists, lovedTracks } = data;

	favoriteArtists.value = artists || [];
	favoriteAlbums.value = albums || [];
	favoritePlaylists.value = playlists || [];
	favoriteTracks.value = tracks || [];
	lovedTracksPlaylist.value = lovedTracks || [];
};

const setSpotifyPlaylists = (response) => {
	if (response.error) {
		switch (response.error) {
			case "spotifyNotEnabled":
				loginStore.setSpotifyStatus("disabled");
				favoriteSpotifyPlaylists.value = [];
				break;
			case "spotifyPlaylistsUnavailable":
				toast(i18n.global.t("toasts.spotifyPlaylistsUnavailable"), "warning");
				break;
			case "wrongSpotifyUsername":
				toast(
					i18n.global.t("toasts.wrongSpotifyUsername", {
						username: response.username,
					}),
					"person_off"
				);
				break;
			default:
				break;
		}
		return;
	}

	favoriteSpotifyPlaylists.value = response || [];
};

const refreshFavorites = async ({ isInitial = false, force = false } = {}) => {
	if (refreshPromise && !force) return refreshPromise;

	if (force) refreshPromise = null;

	refreshPromise = (async () => {
		if (!isInitial) {
			isRefreshingFavorites.value = true;
		}

		try {
			try {
				await withTimeout(
					loginStore.refreshSpotifyStatus(),
					SPOTIFY_STATUS_TIMEOUT,
					"Spotify status refresh timed out"
				);
			} catch (error) {
				console.error(error);
			}

			const requests = [
				withTimeout(
					fetchData("getUserFavorites"),
					FAVORITES_REFRESH_TIMEOUT,
					"Deezer favorites refresh timed out"
				)
					.then(setAllFavorites)
					.catch(console.error),
				withTimeout(
					fetchData("getUserSpotifyPlaylists"),
					FAVORITES_REFRESH_TIMEOUT,
					"Spotify playlists refresh timed out"
				)
					.then(setSpotifyPlaylists)
					.catch((error) => {
						console.error(error);
						toast(
							i18n.global.t("toasts.spotifyPlaylistsUnavailable"),
							"warning"
						);
					}),
			];

			await Promise.allSettled(requests);
		} finally {
			isRefreshingFavorites.value = false;
			refreshPromise = null;
		}
	})();

	return refreshPromise;
};

export const useFavorites = () => ({
	favoriteArtists,
	favoriteAlbums,
	favoriteSpotifyPlaylists,
	favoritePlaylists,
	favoriteTracks,
	lovedTracksPlaylist,
	isRefreshingFavorites,
	refreshFavorites,
});
