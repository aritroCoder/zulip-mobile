/* @flow strict-local */
import Immutable from 'immutable';
import invariant from 'invariant';

import type { Narrow, UserId } from '../types';
import { userIdsOfPmNarrow } from '../utils/narrow';
import { pmUnreadsKeyFromPmKeyIds } from '../utils/recipient';
import type { PerAccountApplicableAction } from '../actionTypes';
import type {
  UnreadState,
  UnreadStreamsState,
  UnreadPmsState,
  UnreadHuddlesState,
  UnreadMentionsState,
} from './unreadModelTypes';
import type { PerAccountState } from '../reduxTypes';
import unreadPmsReducer from './unreadPmsReducer';
import unreadHuddlesReducer from './unreadHuddlesReducer';
import unreadMentionsReducer from './unreadMentionsReducer';
import {
  EVENT_MESSAGE_DELETE,
  EVENT_NEW_MESSAGE,
  EVENT_UPDATE_MESSAGE,
  EVENT_UPDATE_MESSAGE_FLAGS,
  MESSAGE_FETCH_COMPLETE,
  REGISTER_COMPLETE,
  RESET_ACCOUNT_DATA,
} from '../actionConstants';
import DefaultMap from '../utils/DefaultMap';
import * as logging from '../utils/logging';

//
//
// Selectors.
//
// These take the global state as their input.
//

/** The unread-messages state as a whole. */
export const getUnread = (state: PerAccountState): UnreadState => state.unread;

export const getUnreadStreams = (state: PerAccountState): UnreadStreamsState =>
  state.unread.streams;

export const getUnreadPms = (state: PerAccountState): UnreadPmsState => state.unread.pms;

export const getUnreadHuddles = (state: PerAccountState): UnreadHuddlesState =>
  state.unread.huddles;

export const getUnreadMentions = (state: PerAccountState): UnreadMentionsState =>
  state.unread.mentions;

//
//
// Getters.
//
// These operate directly on this particular model's state, as part of this
// model's own interface.
//

/** The total number of unreads in the given topic. */
export const getUnreadCountForTopic = (
  unread: UnreadState,
  streamId: number,
  topic: string,
): number => unread.streams.get(streamId)?.get(topic)?.size ?? 0;

/** All the unread message IDs for a given PM narrow. */
export const getUnreadIdsForPmNarrow = (
  unread: UnreadState,
  narrow: Narrow,
  ownUserId: UserId,
): $ReadOnlyArray<number> => {
  const userIds = userIdsOfPmNarrow(narrow);

  if (userIds.length > 1) {
    const unreadsKey = pmUnreadsKeyFromPmKeyIds(userIds, ownUserId);
    const unreadItem = unread.huddles.find(x => x.user_ids_string === unreadsKey);
    return unreadItem?.unread_message_ids ?? [];
  } else {
    const senderId = userIds[0];
    const unreadItem = unread.pms.find(x => x.sender_id === senderId);
    return unreadItem?.unread_message_ids ?? [];
  }
};

//
//
// Reducer.
//

const initialStreamsState: UnreadStreamsState = Immutable.Map();

// Like `Immutable.Map#update`, but prune returned values equal to `zero`.
function updateAndPrune<K, V>(
  map: Immutable.Map<K, V>,
  zero: V,
  key: K,
  updater: (V | void) => V,
): Immutable.Map<K, V> {
  const value = map.get(key);
  const newValue = updater(value);
  if (newValue === zero) {
    return map.delete(key);
  }
  if (newValue === value) {
    return map;
  }
  return map.set(key, newValue);
}

// Like `Immutable.Map#map`, but with the update-only-if-different semantics
// of `Immutable.Map#update`.  Kept for comparison to `updateAllAndPrune`.
/* eslint-disable-next-line no-unused-vars */
function updateAll<K, V>(map: Immutable.Map<K, V>, updater: V => V): Immutable.Map<K, V> {
  return map.withMutations(mapMut => {
    map.forEach((value, key) => {
      const newValue = updater(value);
      if (newValue !== value) {
        mapMut.set(key, newValue);
      }
    });
  });
}

// Like `updateAll`, but prune values equal to `zero` given by `updater`.
function updateAllAndPrune<K, V>(
  map: Immutable.Map<K, V>,
  zero: V,
  updater: V => V,
): Immutable.Map<K, V> {
  return map.withMutations(mapMut => {
    map.forEach((value, key) => {
      const newValue = updater(value);
      if (newValue === zero) {
        mapMut.delete(key);
        return;
      }
      if (newValue === value) {
        return; // i.e., continue
      }
      mapMut.set(key, newValue);
    });
  });
}

/**
 * The union of sets, represented as sorted lists.
 *
 * The inputs must be sorted (by `<`) and without duplicates (by `===`).
 *
 * The output will contain all the elements found in either input, again
 * sorted and without duplicates.
 */
// TODO: This implementation is Θ(n log n), because it repeatedly looks up
//   elements by numerical index.  It would be nice to instead use cursors
//   within the tree to get an O(n) implementation.
export function setUnion<T: number>(
  xs: Immutable.List<T>,
  ys: Immutable.List<T>,
): Immutable.List<T> {
  // TODO: Perhaps build a List directly, with setSize up front.
  const result = [];
  let i = 0;
  let x = xs.get(i++);
  let j = 0;
  let y = ys.get(j++);
  while (x !== undefined && y !== undefined) {
    if (x < y) {
      result.push(x);
      x = xs.get(i++);
    } else if (x !== y) {
      result.push(y);
      y = ys.get(j++);
    } else {
      // x === y
      result.push(x);
      x = xs.get(i++);
      y = ys.get(j++);
    }
  }
  while (x !== undefined) {
    result.push(x);
    x = xs.get(i++);
  }
  while (y !== undefined) {
    result.push(y);
    y = ys.get(j++);
  }
  return Immutable.List(result);
}

function deleteMessagesIn(
  state: UnreadStreamsState,
  streamId: number,
  topic: string,
  ids: Set<number>,
): UnreadStreamsState {
  return updateAndPrune(state, Immutable.Map(), streamId, (perStream = Immutable.Map()) =>
    updateAndPrune(perStream, Immutable.List(), topic, (perTopic = Immutable.List()) =>
      perTopic.filter(id => !ids.has(id)),
    ),
  );
}

function deleteMessages(
  state: UnreadStreamsState,
  ids: $ReadOnlyArray<number>,
): UnreadStreamsState {
  const idSet = new Set(ids);
  const toDelete = id => idSet.has(id);
  const emptyList: Immutable.List<number> = Immutable.List();
  return updateAllAndPrune(state, Immutable.Map(), perStream =>
    updateAllAndPrune(perStream, emptyList, (perTopic: Immutable.List<number>) =>
      perTopic.find(toDelete) ? perTopic.filterNot(toDelete) : perTopic,
    ),
  );
}

function streamsReducer(
  state: UnreadStreamsState = initialStreamsState, // eslint-disable-line default-param-last
  action: PerAccountApplicableAction,
  globalState: PerAccountState,
): UnreadStreamsState {
  switch (action.type) {
    case RESET_ACCOUNT_DATA:
      return initialStreamsState;

    case REGISTER_COMPLETE: {
      // TODO(#5102): Delete fallback once we refuse to connect to Zulip
      //   servers before 1.7.0, when it seems this feature was added; see
      //   comment on InitialDataUpdateMessageFlags.
      // flowlint-next-line unnecessary-optional-chain:off
      const data = action.data.unread_msgs?.streams ?? [];

      // First, collect together all the data for a given stream, just in a
      // plain old Array.
      const byStream = new DefaultMap(() => []);
      for (const { stream_id, topic, unread_message_ids } of data) {
        // unread_message_ids is already sorted; see comment at its
        // definition in src/api/initialDataTypes.js.
        byStream.getOrCreate(stream_id).push([topic, Immutable.List(unread_message_ids)]);
      }

      // Then, for each of those plain Arrays build an Immutable.Map from it
      // all in one shot.  This is quite a bit faster than building the Maps
      // incrementally.  For a user with lots of unreads in a busy org, we
      // can be handling 50k message IDs here, across perhaps 2-5k threads
      // in dozens of streams, so the effect is significant.
      return Immutable.Map(Immutable.Seq.Keyed(byStream.map.entries()).map(Immutable.Map));
    }

    case MESSAGE_FETCH_COMPLETE:
      // TODO handle MESSAGE_FETCH_COMPLETE here.  This rarely matters, but
      //   could in principle: we could be fetching some messages from
      //   before the (long) window included in the initial unreads data.
      //   For comparison, the webapp does handle this case; see the call to
      //   message_util.do_unread_count_updates in message_fetch.js.
      return state;

    case EVENT_NEW_MESSAGE: {
      const { message } = action;
      if (message.type !== 'stream') {
        return state;
      }

      invariant(message.flags, 'message in EVENT_NEW_MESSAGE must have flags');
      if (message.flags.includes('read')) {
        return state;
      }

      // prettier-ignore
      return state.updateIn([message.stream_id, message.subject],
        (perTopic = Immutable.List()) => perTopic.push(message.id));
    }

    case EVENT_MESSAGE_DELETE:
      // TODO optimize by looking up directly; see #4684
      return deleteMessages(state, action.messageIds);

    case EVENT_UPDATE_MESSAGE_FLAGS: {
      if (action.flag !== 'read') {
        return state;
      }

      if (action.all) {
        return initialStreamsState;
      }

      if (action.op === 'remove') {
        const { message_details } = action;
        if (message_details === undefined) {
          logging.warn('Got update_message_flags/remove/read event without message_details.');
          return state;
        }

        let newlyUnreadState: Immutable.Map<
          number,
          Immutable.Map<string, Immutable.List<number>>,
        > = Immutable.Map();

        for (const id of action.messages) {
          const message = message_details.get(id);

          // The server should ensure that all messages sent are in
          // message_details, so the first `message` here is defensive.
          if (message && message.type === 'stream') {
            newlyUnreadState = newlyUnreadState.updateIn(
              [message.stream_id, message.topic],
              Immutable.List(),
              messages => messages.push(id),
            );
          }
        }

        // We rely in `setUnion` below on these being sorted.  Even if we
        // didn't, and sorted there, it wouldn't catch messages that are in
        // newlyUnreadState but not the existing state.  So sort here too.
        newlyUnreadState = newlyUnreadState.map(e => e.map(messages => messages.sort()));

        return state.mergeWith(
          (oldTopicsMap, newTopicsMap) =>
            oldTopicsMap.mergeWith(
              (oldUnreadMessages, newUnreadMessages) =>
                setUnion(oldUnreadMessages, newUnreadMessages),
              newTopicsMap,
            ),
          newlyUnreadState,
        );
      }

      // TODO optimize by looking up directly; see #4684.
      //   Then when do, also optimize so deleting the oldest items is fast,
      //   as that should be the common case here.
      return deleteMessages(state, action.messages);
    }

    case EVENT_UPDATE_MESSAGE: {
      const { event, move } = action;
      if (!move) {
        return state;
      }

      const eventIds = new Set(event.message_ids);
      const matchingIds = state
        .getIn([move.orig_stream_id, move.orig_topic], Immutable.List())
        .filter(id => eventIds.has(id));
      if (matchingIds.size === 0) {
        // None of the updated messages were unread.
        return state;
      }

      return deleteMessagesIn(state, move.orig_stream_id, move.orig_topic, eventIds).updateIn(
        [move.new_stream_id, move.new_topic],
        (messages = Immutable.List()) => messages.push(...matchingIds).sort(),
      );
    }

    default:
      return state;
  }
}

export const reducer = (
  state: void | UnreadState,
  action: PerAccountApplicableAction,
  globalState: PerAccountState,
): UnreadState => {
  const nextState = {
    streams: streamsReducer(state?.streams, action, globalState),

    // Note for converting these other sub-reducers to the new design:
    // Probably first push this four-part data structure down through the
    // `switch` statement, and the other logic that's duplicated between them.
    pms: unreadPmsReducer(state?.pms, action, globalState),
    huddles: unreadHuddlesReducer(state?.huddles, action, globalState),
    mentions: unreadMentionsReducer(state?.mentions, action),
  };

  if (state && Object.keys(nextState).every(key => nextState[key] === state[key])) {
    return state;
  }

  return nextState;
};
