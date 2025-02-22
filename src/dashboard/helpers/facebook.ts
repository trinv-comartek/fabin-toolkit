import axios from 'axios';
import { sleep } from '@helpers/sleep';
import moment from 'moment';

export interface FacebookUserInfo {
    name: string;
    fb_dtsg?: string;
    uid: string;
    gender?: string;
}

export enum Gender {
    FEMALE = 'FEMALE',
    MALE = 'MALE',
    UNKNOWN = 'UNKNOWN',
}

export class LikedPageNode {
    id: string;
    image: {
        uri: string;
    };
    node: {
        id: string;
        url: string;
    };
    title: {
        text: string;
    };
    url: string;
}

export interface FriendInfo {
    friendship_status?: string;
    gender?: Gender;
    id?: string;
    name?: string;
    profile_picture?: {
        uri?: string;
    };
    short_name?: string;
    social_context?: { text?: string };
    text?: string;
    subscribe_status?: string;
    url?: string;
}

export interface NodeInfo {
    id: string;
    name: string;
    profile_picture?: {
        uri: string;
    };
    url?: string;
}

export interface InteractCount {
    reaction: number;
    comment: number;
}

export interface InteractPost {
    reactions: string[];
    comments: string[];
}

export enum InteractType {
    REACTION = 'REACTION',
    COMMENT = 'COMMENT',
}

export interface InteractionMapValue {
    info: NodeInfo;
    interaction: InteractCount;
    interactIn: InteractPost;
}

export interface FriendRequest {
    friendship_status: string;
    id: string;
    name: string;
    profile_picture?: {
        uri?: string;
    };
    social_context: {
        text?: string;
    };
    social_context_top_mutual_friends?: NodeInfo;
}

class Facebook {
    private cookie: string;
    private userInfo: FacebookUserInfo;
    private baseURL = 'https://www.facebook.com/api/graphql';
    private friends: FriendInfo[] = [];
    private LOCAL_STORAGE_KEY_NAME = {
        FRIENDS: 'FRIENDS_',
    };

    async init() {
        if (this?.userInfo?.uid) {
            return this;
        }

        await this.getMe();
        return this;
    }

    async getCookies() {
        return new Promise(resolve => {
            chrome.cookies.getAll(
                {
                    domain: '.facebook.com',
                },
                function (cookies) {
                    this.cookie = cookies.reduce((result, cookie) => {
                        result += cookie.name + ':' + cookie.value + '; ';
                        return result;
                    }, '');
                    resolve(this.cookie);
                },
            );
        });
    }

    async getMe(): Promise<FacebookUserInfo> {
        const profileSource = await axios
            .get('https://m.facebook.com/profile.php')
            .then(res => res.data);

        const uidRegex = /{"ACCOUNT_ID":"([0-9]*)"/gm;
        const nameRegex = /<title>(.*)<\/title>/gm;
        const fbDtsgRegex =
            /input type="hidden" name="fb_dtsg" value="(.*)" autocomplete="off" \/><input t/gm;

        const uid = uidRegex.exec(profileSource)?.[1];
        const name = nameRegex.exec(profileSource)?.[1];
        const fb_dtsg = fbDtsgRegex.exec(profileSource)?.[1];

        this.userInfo = {
            uid,
            name,
            fb_dtsg,
        };

        return this.userInfo;
    }

    convertObjectToFormData(object: { [key: string]: any }) {
        const formData = new FormData();
        for (const property in object) {
            formData.append(property, object[property]);
        }
        return formData;
    }

    async graphQL(query: { [key: string]: any }) {
        // Convert object to form data
        const formData = this.convertObjectToFormData(query);
        return axios.post(this.baseURL, formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
            },
        });
    }

    async getUserInfoByUrl(url: string): Promise<FacebookUserInfo> {
        const { pathname, searchParams } = new URL(url);
        let username;
        if (pathname === '/profile.php') {
            username = searchParams.get('id');
        } else {
            username = pathname.slice(1);
        }

        const profileURL = 'https://mbasic.facebook.com/' + username;
        const profileSource = await axios.get(profileURL).then(res => res.data);

        const idRegex = /<input type="hidden" name="id" value="(\d*)"/g;
        const nameRegex = /<title>(.*)<\/title>/g;

        const uid = idRegex.exec(profileSource)?.[1];
        const name = nameRegex.exec(profileSource)?.[1];

        return {
            uid,
            name,
        };
    }

    calculateInteractionTime(
        interactionMap: Map<string, InteractionMapValue>,
        nodes: { id: string; name: string }[],
        interactionType: InteractType,
        ignoreIds?: string[],
        postId?: string,
    ) {
        for (const node of nodes) {
            const { id } = node;
            if (ignoreIds?.includes(id)) continue;

            if (interactionMap.has(id)) {
                const { interaction, info, interactIn } =
                    interactionMap.get(id);
                const { comment, reaction } = interaction;
                interactionMap.set(id, {
                    info,
                    interaction: {
                        comment:
                            interactionType === InteractType.COMMENT
                                ? comment + 1
                                : comment,
                        reaction:
                            interactionType === InteractType.REACTION
                                ? reaction + 1
                                : reaction,
                    },
                    interactIn: {
                        comments:
                            interactionType === InteractType.COMMENT
                                ? [...interactIn.comments, postId]
                                : interactIn.comments,
                        reactions:
                            interactionType === InteractType.REACTION
                                ? [...interactIn.reactions, postId]
                                : interactIn.reactions,
                    },
                });
            } else {
                interactionMap.set(id, {
                    info: node,
                    interaction: {
                        comment:
                            interactionType === InteractType.COMMENT ? 1 : 0,
                        reaction:
                            interactionType === InteractType.REACTION ? 1 : 0,
                    },
                    interactIn: {
                        comments:
                            interactionType === InteractType.COMMENT
                                ? [postId]
                                : [],
                        reactions:
                            interactionType === InteractType.REACTION
                                ? [postId]
                                : [],
                    },
                });
            }
        }

        return interactionMap;
    }

    async getInteractions(
        uid: string,
        startDate: number,
        endDate: number,
    ): Promise<Map<string, InteractionMapValue>> {
        let after = '';
        let interactionMap = new Map<string, InteractionMapValue>();

        let isStop = false;
        while (!isStop) {
            const query = `node(${uid}){timeline_feed_units.first(250).after(${after}){page_info,edges{node{id,creation_time,feedback{reactors{nodes{id,name}},commenters{nodes{id,name}}}}}}}`;
            const response = await this.graphQL({
                q: query,
                fb_dtsg: this.userInfo.fb_dtsg,
            });

            const { edges = [], page_info = {} } =
                response?.data?.[uid]?.timeline_feed_units || {};

            for (const edge of edges) {
                const { node } = edge;
                const { creation_time, feedback, id } = node;
                const postId = atob(id).split(':').pop();

                const createTimeMoment = moment(creation_time * 1000);

                if (
                    createTimeMoment.isAfter(moment(startDate)) &&
                    createTimeMoment.isBefore(moment(endDate))
                ) {
                    if (feedback?.commenters?.nodes) {
                        this.calculateInteractionTime(
                            interactionMap,
                            feedback?.commenters?.nodes,
                            InteractType.COMMENT,
                            [uid],
                            postId,
                        );
                    }
                    if (feedback?.reactors?.nodes) {
                        this.calculateInteractionTime(
                            interactionMap,
                            feedback?.reactors?.nodes,
                            InteractType.REACTION,
                            [uid],
                            postId,
                        );
                    }
                }

                if (createTimeMoment.isBefore(moment(startDate))) {
                    isStop = true;
                    break;
                }
            }

            if (page_info?.has_next_page) {
                after = page_info?.end_cursor;
            } else {
                break;
            }
        }

        return interactionMap;
    }

    async getLikedPage(
        targetId: string,
        callbackPercent?: (percent: number) => void,
    ) {
        let result: LikedPageNode[] = [];
        const { uid, fb_dtsg } = this.userInfo;
        let cursor = '';
        const base64Id = btoa(`app_collection:${targetId}:2409997254:96`);

        while (true) {
            let query = {
                __user: uid,
                __a: 1,
                dpr: 1,
                fb_dtsg,
                fb_api_caller_class: 'RelayModern',
                fb_api_req_friendly_name:
                    'ProfileCometAppCollectionGridRendererPaginationQuery',
                variables: `{"count":8,"cursor":"${cursor}","scale":1,"id":"${base64Id}"}`,
                doc_id: '2983410188445167',
            };

            const response = await this.graphQL(query);
            const data = response?.data?.data?.node?.items;
            if (!data) {
                throw new Error("Can't get liked page of this user");
            }
            const { edges = [], page_info, count = 0 } = data;

            if (!page_info?.has_next_page) {
                break;
            } else {
                cursor = page_info.end_cursor;
                // await sleep(2 * 1000);
            }

            for (const edge of edges) {
                if (edge?.node) {
                    result.push(edge.node);
                }
            }
            if (typeof callbackPercent === 'function') {
                const percent = ((result.length || 0) / count) * 100;
                callbackPercent(percent);
            }
        }

        return result;
    }

    async getFriends(isLocal: boolean = true): Promise<{
        createdAt?: number;
        data: FriendInfo[];
    }> {
        if (!this.userInfo) {
            throw new Error("Can't get user info");
        }
        const { uid, fb_dtsg } = this.userInfo;

        if (isLocal) {
            const localFriendsJson = localStorage.getItem(
                this.LOCAL_STORAGE_KEY_NAME.FRIENDS + uid,
            );

            if (localFriendsJson && localFriendsJson !== '') {
                this.friends = JSON.parse(localFriendsJson);
                return this.friends as any;
            }
        }

        let query = {
            __user: uid,
            __a: 1,
            dpr: 1,
            fb_dtsg,
            fb_api_caller_class: 'RelayModern',
            fb_api_req_friendly_name:
                'FriendingCometFriendsListPaginationQuery',
            variables: `{ count: 30, cursor: null, name: null, scale: 1 }`,
            doc_id: 4858065864249125,
        };

        while (true) {
            const response = await this.graphQL(query);
            const allFriends = response?.data?.data?.viewer?.all_friends;
            const { edges = [], page_info } = allFriends;

            if (!page_info?.has_next_page) {
                break;
            } else {
                query.variables = `{ count: 30, cursor: '${page_info?.end_cursor}', name: null, scale: 1 }`;
                await sleep(2 * 1000);
            }

            for (const edge of edges) {
                if (edge?.node) {
                    this.friends.push(edge.node);
                }
            }
        }

        localStorage.setItem(
            this.LOCAL_STORAGE_KEY_NAME.FRIENDS + uid,
            JSON.stringify({
                data: this.friends,
                createdAt: new Date().getTime(),
            }),
        );

        return {
            data: this.friends,
            createdAt: new Date().getTime(),
        };
    }

    async getFriendRequests(): Promise<FriendRequest[]> {
        let result: FriendRequest[] = [];
        let cursor = '';
        const { uid, fb_dtsg } = this.userInfo;

        while (true) {
            const query = {
                av: uid,
                __user: uid,
                fb_dtsg,
                fb_api_caller_class: 'RelayModern',
                fb_api_req_friendly_name:
                    'FriendingCometFriendRequestsGridPaginationQuery',
                variables: `{"count":20,"cursor":"${cursor}","scale":2}`,
                server_timestamps: true,
                doc_id: '5073444706045886',
            };
            const response = await this.graphQL(query);
            const friendRequests =
                response?.data?.data?.viewer?.friend_requests;
            const { edges = [], page_info } = friendRequests;
            for (const edge of edges) {
                if (edge?.node) {
                    result.push(edge.node);
                }
            }
            if (!page_info?.has_next_page) {
                break;
            } else {
                cursor = page_info.end_cursor;
            }
        }
        return result;
    }

    async getSentRequests() {
        let result: FriendRequest[] = [];
        let cursor = '';
        const { uid, fb_dtsg } = this.userInfo;

        while (true) {
            const query = {
                av: uid,
                __user: uid,
                fb_dtsg,
                fb_api_caller_class: 'RelayModern',
                fb_api_req_friendly_name:
                    'FriendingCometOutgoingRequestsDialogQuery',
                variables: `{"count":20,"cursor":"${cursor}","scale":2}`,
                server_timestamps: true,
                doc_id: '7114490868621087',
            };
            const response = await this.graphQL(query);
            const {
                outgoing_friend_requests_connection,
                outgoing_friend_requests,
            } = response?.data?.data?.viewer;
            const { edges = [], page_info } =
                outgoing_friend_requests_connection;
            const { count } = outgoing_friend_requests;

            for (const edge of edges) {
                if (edge?.node) {
                    result.push(edge.node);
                }
            }
            if (!page_info?.has_next_page || result?.length >= count) {
                break;
            } else {
                cursor = page_info.end_cursor;
            }
        }
        return result;
    }

    processFriendRequest(targetId: string, action: 'confirm' | 'delete') {
        const { uid, fb_dtsg } = this.userInfo;
        const mutationName =
            action === 'confirm'
                ? 'FriendingCometFriendRequestConfirmMutation'
                : 'FriendingCometFriendRequestDeleteMutation';
        const deleteVariables = `{"input":{"friend_requester_id":"${targetId}","source":"friends_tab","actor_id":"${uid}","client_mutation_id":"5"},"scale":2,"refresh_num":0}`;
        const confirmVairables = `{"input":{"attribution_id_v2":"FriendingCometRoot.react,comet.friending,tap_bookmark,1665735258869,351351,2356318349,","friend_requester_id":"${targetId}","source":"friends_tab","actor_id":"${uid}","client_mutation_id":"4"},"scale":2,"refresh_num":0}`;

        const data = {
            av: uid,
            __user: uid,
            fb_dtsg,
            fb_api_caller_class: 'RelayModern',
            fb_api_req_friendly_name: mutationName,
            server_timestamps: true,
            variables:
                action === 'confirm' ? confirmVairables : deleteVariables,
            doc_id: action === 'confirm' ? 6183939714956490 : 5211510105641511,
            fb_api_analytics_tags: ['qpl_active_flow_ids=30605361'],
        };

        return this.graphQL(data);
    }

    unfriend(targetId: string) {
        const { uid, fb_dtsg } = this.userInfo;

        const data = {
            av: uid,
            __user: uid,
            fb_dtsg,
            fb_api_caller_class: 'RelayModern',
            fb_api_req_friendly_name: 'FriendingCometUnfriendMutation',
            server_timestamps: true,
            variables: `{"input":{"source":"bd_profile_button","unfriended_user_id":"${targetId}","actor_id":"${uid}","client_mutation_id":"1"},"scale":2}`,
            doc_id: 5400234993334462,
        };
        return this.graphQL(data);
    }
}

export default Facebook;
