/* @flow */
import React, { PureComponent } from 'react';
import { StyleSheet, View } from 'react-native';

import ComposeIcon from './ComposeIcon';

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
  },
});

export default class ComposeOptions extends PureComponent {
  props: {
    selected: number,
    onChange: (index: number) => {},
  };

  handleOnChange = () => this.props.onChange(0);

  render() {
    const { selected } = this.props;

    return (
      <View style={styles.container}>
        <ComposeIcon name="md-text" isActive={selected === 0} onChange={this.handleOnChange} />
        {/* <ComposeIcon name="md-image" isActive={selected === 1} onChange={() => onChange(1)} />
          <ComposeIcon name="md-camera" isActive={selected === 2} onChange={() => onChange(2)} />
          <ComposeIcon name="md-videocam" isActive={selected === 3} onChange={() => onChange(3)} />
          <ComposeIcon name="md-happy" isActive={selected === 4} onChange={() => onChange(4)} /> */}
      </View>
    );
  }
}
